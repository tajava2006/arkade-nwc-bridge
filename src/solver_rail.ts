import type { Database } from 'bun:sqlite'
import type { IWallet } from '@arkade-os/sdk'
import { discover } from '@arkade-os/solver-discovery'
import { createSwapClient, type SwapClient } from '@arkade-os/swap'
import { httpTransport } from '@arkade-os/swap/protocol'
import type { Network } from './defaults'
import type { LightningConfig } from './lightning_config'
import { openSwapRepository } from './swap_store'

// Dust-and-up Lightning through the operator's own intent-solver (D5): the
// high-level swap client, pinned to our solver alone.
//
// - Discovery: our solver's card only, injected as a trusted snapshot; the
//   registry is never read (`registries: []`, `registryUrl: null`). A card
//   alone without the snapshot is "no snapshot" to the client (SM-12).
// - Transport: plain HTTP on the private network, attested to the card's
//   discovery key — the same trust as the bridge's plain HTTP to arkd. If the
//   solver is ever exposed beyond that network, revisit.
// - Emulator: our own key (D6). The SDK default is Ark Labs', and a refund
//   covenant built on it could only be co-signed by them.
// - Drive: "auto" (the default): the client claims receives and refunds
//   failed sends by itself, resuming whatever the store holds at boot.

export interface SolverRail {
  readonly client: SwapClient
  dispose(): Promise<void>
}

export async function startSolverRail(deps: {
  wallet: IWallet
  db: Database
  lightning: LightningConfig
  network: Network
  fetchImpl?: typeof fetch
}): Promise<SolverRail> {
  const { lightning, network } = deps
  const { markets } = await discover({
    registries: [],
    localCards: [{ card: lightning.solverCard, network }],
    network,
    ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
  } as never)
  if (markets.length === 0) {
    throw new Error(`the configured solver card advertises no ${network} market`)
  }
  const client = createSwapClient({
    wallet: deps.wallet,
    repository: openSwapRepository(deps.db),
    discovery: { registryUrl: null, snapshot: markets } as never,
    transportFor: ({ solverPubkey }) => ({ ...httpTransport(lightning.solverUrl), attestedResponder: solverPubkey }),
    emulatorPubkey: lightning.emulatorPubkey,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  })
  // The restore read: arms the drive on any live swap left from a previous
  // run (a funded send to refund, a held receive to claim). Rejects only on an
  // unreadable store, which must stop boot.
  await client.ready
  return { client, dispose: () => client[Symbol.asyncDispose]() }
}
