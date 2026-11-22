import type { Database } from 'bun:sqlite'
import { isSubdust, type OperatorInfo, type ExtendedVirtualCoin, type Wallet } from '@arkade-os/sdk'
import { selectSpendInputs } from './coin_select'
import { makeExitCostOracle } from './exit/cost_oracle'

// The single funnel for coins leaving the wallet offchain, and the hot-pocket
// shape that makes the funnel's job easy (SEND_DESIGN.md §9). Every rail that
// spends VTXOs offchain goes through `sendSelected`; nothing calls
// `wallet.send` with its own selector any more, because the SDK's own
// selector reaches for the LARGEST coin first (expiry asc, then value desc) and
// that is precisely the coin we want to keep pristine.

/**
 * Size of the designated wear pocket carved out after each consolidate-all.
 *
 * The only thing this number really sets is **how much the wallet writes off in
 * an ASP-death scenario**: the pocket is the coin every small spend chains
 * onto, so its exit cost climbs past its value quickly and it becomes
 * economically abandoned — by design. Everything else keeps exiting at
 * batch-leaf cost.
 *
 * 5,000 sats is not a tuned number and does not need to be. What it has to
 * clear is longevity: a sub-dust send only consumes `a + fee`, so a 5k pocket
 * absorbs thousands of 1-sat zaps before it drops under the ~661 sats an atomic
 * funding needs (dust + a + fee). When it finally does, nothing breaks — the
 * selector simply spends the cold coin alone and its change becomes the new
 * working coin. There is deliberately no refill machinery.
 */
export const HOT_POCKET_SATS = 5_000

/**
 * How many pockets to keep. One was not enough: a sub-dust send spends its
 * coin WHOLE, and our change only comes back after subdustd has paid the invoice
 * and run the claim split — so for the length of an external LN payment the
 * wallet holds no hot coin at all, and a second zap fired in that window
 * (Amethyst zaps several people in one tap) had nothing left but cold.
 *
 * Serializing instead would mean holding a lock across that LN payment, and
 * across a stuck swap until the cooperative cancel or T — up to the whole send
 * window. Extra lanes cost nothing by comparison: the pockets are written off
 * in exit terms almost immediately whether there is one or three, so the
 * portfolio value is the same, and the write-off ceiling is per-pocket by
 * design. Beyond N concurrent sends it degrades gently to cold rather than
 * failing or waiting.
 */
export const HOT_POCKET_COUNT = 3

export interface SpendDeps {
  wallet: Wallet
  db: Database
  /** arkd getInfo — `dust` sizes the change guard, `deprecatedSigners` gates explicit selection. */
  arkInfo: Pick<OperatorInfo, 'dust' | 'deprecatedSigners'>
}

/**
 * VTXOs an offchain spend can actually consume: the SDK's selection pool
 * (`withRecoverable: false` drops swept/expired) minus fresh sub-dust, which
 * sits in that pool but can only be consumed by a settlement round.
 *
 * SDK 0.5 port (money path — coin selection): `getSpendableVtxos`, not
 * `getVtxos`. 0.5's getVtxos also reports contract-locked, deprecated-signer
 * and pending-settlement coins, and handing those to `send({ selectedVtxos })`
 * bypasses the SDK's generic-spending gate (its own docs say so).
 */
export async function spendablePool(wallet: Wallet, dust: bigint): Promise<ExtendedVirtualCoin[]> {
  const vtxos = await wallet.getSpendableVtxos({ withRecoverable: false })
  return vtxos.filter((v) => !isSubdust(v, dust))
}

export const poolSats = (pool: ExtendedVirtualCoin[]): number => pool.reduce((n, v) => n + v.value, 0)

/**
 * Explicit selection is unsafe to use while the ASP advertises deprecated
 * signers: `Wallet.send({ selectedVtxos })` skips the generic-spending gate
 * (the `pendingRecoveryOutpoints()` filter implicit selection applies), and that
 * filter is exactly what keeps a send off VTXOs an in-flight recovery intent
 * has already committed to. That set is empty unless deprecated signers exist,
 * so in the normal case we lose nothing — but when they do exist, correctness
 * beats coin policy and we hand selection back to the SDK.
 */
const explicitSelectionSafe = (arkInfo: SpendDeps['arkInfo']): boolean =>
  (arkInfo.deprecatedSigners ?? []).length === 0

/**
 * Send `amount` to `address` offchain, choosing the inputs ourselves
 * (coin_select.ts). THE offchain-send entry point — plain Ark sends and dust+
 * submarine-swap funding both land here so one policy governs both.
 *
 * `pool` may be passed in when the caller already read it (the LN rail sizes
 * its drain against the same numbers and must not re-read between the two).
 */
/**
 * Residue up to this many sats above `amount` may stay behind as sub-dust
 * change instead of refusing the send: a drain sized by our fee mirror can
 * disagree by ±1 with the server's rounding. The 1–2 sats stay ours — a
 * recoverable sub-dust vtxo the next consolidate-all sweeps in (the SDK burns
 * it as fee only below the operator's vtxo minimum). Any larger residue must
 * still compose as ≥ dust change. Before the solver this was an overpay the
 * swap provider kept; a solver lockup must be exact, and giving the sats away
 * was never better than keeping them.
 */
export const DRAIN_SLACK_SATS = 2

export async function sendSelected(
  deps: SpendDeps,
  params: {
    address: string
    amount: number
    pool?: ExtendedVirtualCoin[]
    /** The SDK refuses before submission at/after this unix second (a quote's funding deadline). */
    validUntil?: number
  },
): Promise<string> {
  const dust = Number(deps.arkInfo.dust)
  const pool = params.pool ?? (await spendablePool(deps.wallet, deps.arkInfo.dust))

  const deadline = params.validUntil === undefined ? {} : { validUntil: params.validUntil }
  if (!explicitSelectionSafe(deps.arkInfo)) {
    console.warn('spend: ASP advertises deprecated signers — deferring coin choice to the SDK')
    const recipient = { address: params.address, amount: params.amount }
    return params.validUntil === undefined ? deps.wallet.send(recipient) : deps.wallet.send({ recipients: [recipient], ...deadline })
  }

  let selected = selectSpendInputs(pool, {
    target: params.amount,
    changeDust: dust,
    exitCostOf: makeExitCostOracle(deps.db),
  })
  const surplus = poolSats(pool) - params.amount
  if (selected.length === 0 && surplus > 0 && surplus <= DRAIN_SLACK_SATS) selected = pool
  if (selected.length === 0) {
    // Distinguish "not enough money" from "enough money, but only in shapes
    // that would leave sub-dust change" — the second reads as a bug otherwise.
    const total = poolSats(pool)
    throw new Error(
      total < params.amount
        ? `send needs ${params.amount} sats but only ${total} are offchain-spendable — sub-dust/swept funds don't count until a Refresh`
        : `send of ${params.amount} sats can't be composed without leaving sub-dust change (${total} sats spendable) — Refresh first`,
    )
  }

  // `selectedVtxos` is the ONLY explicit-selection surface the SDK exposes —
  // the variadic send(...recipients) always runs its own selector. In 0.5 it
  // moved from the deprecated sendBitcoin onto send's object form, "spent as
  // given, nothing added". If an SDK bump drops it, the unit test pins the contract.
  return deps.wallet.send({
    recipients: [{ address: params.address, amount: params.amount }],
    selectedVtxos: selected,
    ...deadline,
  })
}

/**
 * `wallet` with its plain single-recipient BTC sends routed through
 * sendSelected — for code that funds through `wallet.send` on its own, i.e. the
 * swap client's lockup funding, so one coin policy still governs every spend.
 * Anything sendSelected doesn't model (assets, extensions, tap trees, an
 * explicit selection, an input-expiry floor, several recipients) goes to the
 * SDK untouched. Every other member is the wallet's own.
 */
export function withSpendPolicy(wallet: Wallet, deps: { db: Database; arkInfo: () => Promise<SpendDeps['arkInfo']> }): Wallet {
  type Plain = { address: string; amount: number; validUntil?: number }
  const plain = (args: unknown[]): Plain | undefined => {
    const one = (r: Record<string, unknown>): Plain | undefined => {
      const keys = Object.keys(r).filter((k) => r[k] !== undefined)
      return keys.every((k) => k === 'address' || k === 'amount') && typeof r.address === 'string' && typeof r.amount === 'number'
        ? { address: r.address, amount: r.amount }
        : undefined
    }
    if (args.length !== 1 || typeof args[0] !== 'object' || args[0] === null) return undefined
    const a = args[0] as Record<string, unknown>
    if (!('recipients' in a)) return one(a)
    const extra = Object.keys(a).filter((k) => a[k] !== undefined && k !== 'recipients' && k !== 'validUntil')
    const rs = a.recipients as Record<string, unknown>[]
    if (extra.length > 0 || !Array.isArray(rs) || rs.length !== 1) return undefined
    const r = one(rs[0]!)
    return r && { ...r, ...(typeof a.validUntil === 'number' ? { validUntil: a.validUntil } : {}) }
  }
  return new Proxy(wallet, {
    get(target, prop) {
      if (prop === 'send') {
        return async (...args: unknown[]) => {
          const p = plain(args)
          if (!p) return (target.send as (...a: unknown[]) => Promise<string>)(...args)
          return sendSelected({ wallet: target, db: deps.db, arkInfo: await deps.arkInfo() }, p)
        }
      }
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

/**
 * How many pockets are missing from `pool`, capped by what the wallet can
 * actually spare while leaving a cold coin above dust.
 *
 * One threshold, no second magic number: a coin at or under HOT_POCKET_SATS IS
 * a pocket. Worn pockets therefore still count, so a wallet that has simply
 * been spending down never re-splits — that is intended, see HOT_POCKET_SATS.
 */
export function hotPocketsNeeded(pool: ExtendedVirtualCoin[], dust: number): number {
  const missing = HOT_POCKET_COUNT - pool.filter((v) => v.value <= HOT_POCKET_SATS).length
  if (missing <= 0) return 0
  const biggest = pool.reduce((n, v) => Math.max(n, v.value), 0)
  const affordable = Math.floor((biggest - dust) / HOT_POCKET_SATS)
  return Math.max(0, Math.min(missing, affordable))
}

/**
 * Carve the wear pockets out of the consolidated wallet: one self-send that
 * leaves `[hot × N, cold]` instead of a single coin. Multiple recipients in a
 * single tx, so N pockets cost exactly the same one hop as one did.
 *
 * Why not N outputs on the settle itself (which would leave everything at
 * batch-leaf depth instead of one hop, and keep cold `settled` rather than
 * preconfirmed): reproducing no-arg `wallet.settle()` means reimplementing its
 * private internals — boarding-UTXO gathering, per-input fee filtering,
 * MAX_VTXOS_PER_SETTLEMENT, the dust check — against SDK helpers that aren't
 * exported (`byValueDescending`, `toOffchainInputFeeParams`), i.e. code that
 * breaks silently on an SDK bump. Losing boarding absorption on a refresh is a
 * correctness failure; the hop is a FIXED cost paid once per refresh cycle and
 * reset by the next one. If the SDK ever exports enough to gather inputs
 * safely, this is the thing to revisit.
 *
 * Best-effort: a failed split leaves a perfectly good consolidated wallet, so
 * it is logged and swallowed by callers.
 */
export async function splitHotPocket(deps: SpendDeps): Promise<string | undefined> {
  const dust = Number(deps.arkInfo.dust)
  const pool = await spendablePool(deps.wallet, deps.arkInfo.dust)
  const n = hotPocketsNeeded(pool, dust)
  if (n === 0) return undefined

  // Plain wallet.send on purpose: its selector takes the largest coin, which
  // right after a consolidate-all is the one we want to split. Change is the
  // cold remainder.
  const own = await deps.wallet.getAddress()
  const txid = await deps.wallet.send(
    ...(Array.from({ length: n }, () => ({ address: own, amount: HOT_POCKET_SATS })) as [
      { address: string; amount: number },
      ...{ address: string; amount: number }[],
    ]),
  )
  console.log(
    `hot pocket: carved ${n} × ${HOT_POCKET_SATS} sats off the consolidated VTXO ` +
      `(arkTxid ${txid}) — concurrent sends now have ${n} lanes before falling back to cold`,
  )
  return txid
}
