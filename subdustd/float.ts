import type { RenewalSplitContext, VirtualCoin } from '@arkade-os/sdk'
import type { Logger } from './log.ts'

// The float's upkeep. Every receive is funded from subdustd's own coins
// (D10), and a coin past its batch expiry is swept by arkd: it can no longer
// fund anything until it is recovered in a round, so a float nobody renews
// turns every receive into a 503 one tree-expiry after the last top-up. The
// Boltz fork never had this problem because fulmine renewed its wallet.
//
// Renewal goes through the SDK's own VtxoManager (settlementConfig: false — we
// call it, it never runs by itself) with a split that keeps the float's
// SHAPE: receives spend whole coins, so one consolidated coin would let only
// one receive be in flight at a time.

/**
 * Serializes everything that picks float coins: receive funding and renewal.
 * Without it the two can pick the same coin — arkd then accepts one spend and
 * rejects the other, and a renewal round could fail for a coin a receive just
 * spent. Funding holds it for one offchain tx; renewal for one round.
 */
export class FloatLock {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => {})
    return next
  }
}

/**
 * Pieces for a renewal of `values` (the due coins) out of `ctx.subtotal`: one
 * output per coin of at least dust, at its own value; sub-dust value and any
 * fee difference fold into the largest piece; past `maxOutputs` the smallest
 * pieces merge. Every piece stays >= dust and the pieces sum to the subtotal
 * (net of the per-output fee the context reports). Pure, so it is tested
 * without a round.
 */
export function shapePlan(values: readonly number[], ctx: Pick<RenewalSplitContext, 'subtotal' | 'dust' | 'outputFeeOn' | 'hasAssets'>, maxOutputs: number): bigint[] {
  const dust = ctx.dust
  if (ctx.hasAssets) return [ctx.subtotal]
  let pieces = values.map(BigInt).filter((v) => v >= dust).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  if (pieces.length === 0) return [ctx.subtotal]
  while (pieces.length > maxOutputs) {
    const a = pieces.pop()!
    pieces[pieces.length - 1]! += a
    pieces.sort((x, y) => (x < y ? 1 : x > y ? -1 : 0))
  }
  // Fit to what the inputs are worth: output fees come out of the subtotal.
  const fees = pieces.reduce((n, p) => n + ctx.outputFeeOn(p), 0n)
  const target = ctx.subtotal - fees
  const diff = target - pieces.reduce((n, p) => n + p, 0n)
  pieces[0]! += diff
  // A fee bigger than the largest piece's margin: merge down until it fits.
  while (pieces.length > 1 && pieces[0]! < dust) {
    const a = pieces.pop()!
    pieces[0]! += a
  }
  return pieces
}

export interface FloatManager {
  getExpiringVtxos(thresholdMs?: number): Promise<VirtualCoin[]>
  renewVtxos(
    eventCallback?: undefined,
    options?: { thresholdSeconds?: number; split?: { maxOutputs: number; plan(ctx: RenewalSplitContext): readonly bigint[] } },
  ): Promise<string>
  recoverVtxos(): Promise<string>
}

/** One renewal pass, run from the scanner. Never throws — upkeep failing must not stop the swap scan. */
export class FloatRenewer {
  constructor(
    private readonly d: {
      manager: FloatManager
      lock: FloatLock
      /** Renew a coin once its batch has less than this left. */
      thresholdSecs: number
      /** Most outputs one renewal creates (arkd bounds a round's weight). */
      maxOutputs?: number
      log: Logger
    },
  ) {}

  async pass(): Promise<{ renewed?: string; recovered?: string }> {
    const { manager, lock, thresholdSecs, log } = this.d
    const out: { renewed?: string; recovered?: string } = {}
    try {
      const due = await manager.getExpiringVtxos(thresholdSecs * 1000)
      if (due.length > 0) {
        const values = due.map((v) => v.value)
        out.renewed = await lock.run(() =>
          manager.renewVtxos(undefined, {
            thresholdSeconds: thresholdSecs,
            split: { maxOutputs: this.d.maxOutputs ?? 16, plan: (ctx) => shapePlan(values, ctx, this.d.maxOutputs ?? 16) },
          }),
        )
        log.info(`float: renewed ${due.length} coin(s) (${values.reduce((n, v) => n + v, 0)} sats) in round ${out.renewed}`)
      }
    } catch (e) {
      const msg = (e as Error).message
      // Only sub-dust change is due (claim/refund jitter remainders): it cannot
      // form an output alone and rides along the next time a real coin is due.
      if (/below dust threshold/i.test(msg)) log.debug(`float: nothing renewable yet: ${msg}`)
      else log.warn(`float: renewal failed, retrying next pass: ${msg}`)
    }
    try {
      // Coins already swept (subdustd was down past an expiry): back into a
      // fresh batch. Throws when there is nothing to recover — that's the
      // normal case, so only real failures are logged.
      out.recovered = await lock.run(() => manager.recoverVtxos())
      log.info(`float: recovered swept coins in round ${out.recovered}`)
    } catch (e) {
      const msg = (e as Error).message
      if (!/no recoverable vtxos|dust threshold/i.test(msg)) log.warn(`float: recovery failed: ${msg}`)
    }
    return out
  }
}

/**
 * The SDK wallet + VtxoManager over subdustd's own key, built on first use: the
 * scanner runs from boot, arkd may not answer yet, and a renewal that cannot
 * start yet just retries next pass. The wallet must land on exactly the
 * script subdustd funds from — otherwise renewed coins would leave the float
 * (still ours, but invisible to funding) — so a mismatch disables renewal.
 */
export function lazyFloatManager(deps: {
  identity: import('@arkade-os/sdk').SingleKey
  operator: import('@arkade-os/sdk').OperatorProvider
  indexer: import('@arkade-os/sdk').IndexerProvider
  /** subdustd's own funding address (ArkSigner.receiveAddress). */
  expectedAddress: () => Promise<string>
  /** Chain tip height from our own LND — the only chain read renewal makes. */
  chainHeight: () => Promise<number>
}): FloatManager {
  // The SDK reads the chain tip to evaluate height-based expiry, and nothing
  // else on this path. Without an explicit provider it would default to a
  // public esplora (mempool.space on mainnet) — a third party subdustd has no
  // business querying — so the tip comes from our own LND, and every other
  // onchain call refuses loudly (subdustd never boards or broadcasts).
  const onchainProvider = new Proxy(
    { getChainTip: async () => ({ height: await deps.chainHeight(), time: Math.floor(Date.now() / 1000), hash: '' }) },
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop]
        if (prop === 'then') return undefined
        return () => {
          throw new Error(`subdustd's renewal wallet has no onchain provider (${String(prop)})`)
        }
      },
    },
  )
  let manager: Promise<import('@arkade-os/sdk').VtxoManager> | undefined
  const get = () => {
    manager ??= (async () => {
      const { InMemoryContractRepository, InMemoryWalletRepository, VtxoManager, Wallet } = await import('@arkade-os/sdk')
      const wallet = await Wallet.create({
        identity: deps.identity,
        operatorProvider: deps.operator,
        indexerProvider: deps.indexer,
        onchainProvider: onchainProvider as never,
        storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
        settlementConfig: false,
      })
      const [got, want] = [await wallet.getAddress(), await deps.expectedAddress()]
      if (got !== want) throw new Error(`renewal disabled: the SDK wallet address ${got} is not subdustd's funding address ${want}`)
      return new VtxoManager(wallet, false)
    })()
    // A failed build (arkd down) is retried next pass; a mismatch keeps failing loudly.
    manager.catch(() => (manager = undefined))
    return manager
  }
  return {
    getExpiringVtxos: async (ms) => (await get()).getExpiringVtxos(ms),
    renewVtxos: async (cb, options) => (await get()).renewVtxos(cb, options as never),
    recoverVtxos: async () => (await get()).recoverVtxos(),
  }
}
