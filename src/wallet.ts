import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  SingleKey,
  Wallet,
} from '@arkade-os/sdk'
import type { Config } from './config'

export interface ArkContext {
  identity: SingleKey
  wallet: Wallet
  address: string
}

export async function initArkWallet(cfg: Config, privateKey: Uint8Array): Promise<ArkContext> {
  const identity = SingleKey.fromPrivateKey(privateKey)

  const wallet = await Wallet.create({
    identity,
    arkServerUrl: cfg.arkServerUrl,
    // Node has no IndexedDB; rebuild local caches from the indexer on each
    // boot. We have our own sqlite in src/db.ts for bridge-level state
    // (connections, payments, invoices) — that's a separate concern.
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    // Auto-renew VTXOs only when they're within an hour of expiry. The SDK
    // default is 3 days, which (against our 2-week tree expiry) fires renewal
    // rounds far too eagerly — every round is an onchain commitment tx the ASP
    // pays miner fees for, so renewing this late minimises round frequency.
    // Only vtxoThreshold is overridden; boardingUtxoSweep / pollIntervalMs /
    // deprecatedSignerMigration fall back to their defaults (the SDK reads each
    // field with `?? DEFAULT_SETTLEMENT_CONFIG.*`). Seconds, not ms.
    settlementConfig: { vtxoThreshold: 3600 },
  })

  const address = await wallet.getAddress()
  return { identity, wallet, address }
}
