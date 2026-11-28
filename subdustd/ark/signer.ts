import { hex } from '@scure/base'
import {
  DefaultVtxo,
  getAllNormalizedVtxos,
  getNetwork,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  type ArkAddress,
  type CSVMultisigTapscript,
  type IndexerProvider,
  type NetworkName,
  type OperatorInfo,
  type OperatorProvider,
  type VirtualCoin,
} from '@arkade-os/sdk'
import { selectFundingInputs, serverUnrollScript, type EligibilityArgs } from '../../src/atomic/index.ts'
import type { Network } from '../config.ts'

// Key-only Ark capability for the server side of the swap, ported from the
// Boltz fork's ArkSigner onto SDK 0.5. No Wallet: subdustd signs claim pairs and
// its own funding spends directly and submits them to arkd.
//
// Its own script now follows arkd's advertised exit delay. The fork carried an
// override (605184) only because it shared fulmine's key, whose client lib
// hardcoded that delay; a dedicated key has no other wallet to match.

const toXOnly = (k: Uint8Array): Uint8Array => (k.length === 32 ? k : k.subarray(1))
const timelockType = (v: bigint): 'seconds' | 'blocks' => (v >= 512n ? 'seconds' : 'blocks')

// Long enough that one swap step reads one snapshot, short enough that an
// arkd signer rotation or settings change is picked up without a restart.
const INFO_TTL_MS = 60_000

export class ArkSigner {
  readonly identity: SingleKey
  readonly ark: OperatorProvider
  readonly indexer: IndexerProvider
  private cached?: { info: OperatorInfo; at: number }

  constructor(
    privateKey: Uint8Array,
    arkdUrl: string,
    providers: { ark?: OperatorProvider; indexer?: IndexerProvider } = {},
    private readonly infoTtlMs = INFO_TTL_MS,
  ) {
    this.identity = SingleKey.fromPrivateKey(privateKey)
    this.ark = providers.ark ?? new RestOperatorProvider(arkdUrl)
    this.indexer = providers.indexer ?? new RestIndexerProvider(arkdUrl)
  }

  async xOnlyPublicKey(): Promise<Uint8Array> {
    return toXOnly(await this.identity.xOnlyPublicKey())
  }

  async getInfo(force = false): Promise<OperatorInfo> {
    if (force || !this.cached || Date.now() - this.cached.at > this.infoTtlMs) {
      this.cached = { info: await this.ark.getInfo(), at: Date.now() }
    }
    return this.cached.info
  }

  async serverXOnly(): Promise<Uint8Array> {
    return toXOnly(hex.decode((await this.getInfo()).signerPubkey))
  }

  async serverUnroll(): Promise<CSVMultisigTapscript.Type> {
    return serverUnrollScript((await this.getInfo()).checkpointTapscript)
  }

  /** Exit delay of our own script — advertised to the counterparty so it can rebuild our outputs. */
  async selfDelay(): Promise<bigint> {
    return (await this.getInfo()).unilateralExitDelay
  }

  /**
   * Our own wallet script: funding inputs spend through its forfeit leaf. A swap
   * passes the delay it froze at init, so its split rebuilds byte-identically
   * even if arkd's advertised delay moves mid-swap.
   */
  async selfScript(delay?: bigint): Promise<DefaultVtxo.Script> {
    delay ??= await this.selfDelay()
    return new DefaultVtxo.Script({
      pubKey: await this.xOnlyPublicKey(),
      serverPubKey: await this.serverXOnly(),
      csvTimelock: { type: timelockType(delay), value: delay },
    })
  }

  /** Where claim proceeds and the funding top-up go. */
  async receiveAddress(delay?: bigint): Promise<ArkAddress> {
    const info = await this.getInfo()
    return (await this.selfScript(delay)).address(hrpOf(info), await this.serverXOnly())
  }

  /**
   * Every spendable vtxo on our script. Through the SDK's paging reader, which
   * stops on the server's own page totals — never the single first page (F23).
   */
  async ownVtxos(): Promise<VirtualCoin[]> {
    const script = hex.encode((await this.selfScript()).pkScript)
    return getAllNormalizedVtxos(this.indexer, [script], { spendableOnly: true })
  }

  /**
   * Our coins an unroll put on chain and nobody has spent yet. arkd's
   * spendableOnly leaves unrolled vtxos out, so this reads the script's whole
   * history (spent rows too) — called sparingly.
   */
  async ownUnrolledVtxos(): Promise<VirtualCoin[]> {
    const script = hex.encode((await this.selfScript()).pkScript)
    return (await getAllNormalizedVtxos(this.indexer, [script], {})).filter((v) => v.isUnrolled && !v.isSpent)
  }

  /** Ascending whole-input funding for a receive (we are the funder); [] when nothing can cover it. */
  async selectFunding(args: EligibilityArgs & { amount: number }): Promise<VirtualCoin[]> {
    return selectFundingInputs(await this.ownVtxos(), args)
  }
}

export const hrpOf = (info: Pick<OperatorInfo, 'network'>): string => getNetwork(info.network as NetworkName).hrp

export const arkdNetworkMismatch = (network: Network, info: Pick<OperatorInfo, 'network'>): string | undefined =>
  info.network === network ? undefined : `arkd is on ${info.network || 'an unknown network'} but config.network is ${network} — refusing to run`
