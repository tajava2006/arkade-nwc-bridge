import type { Database } from 'bun:sqlite'
import { isSubdust, type ArkInfo, type ExtendedVirtualCoin, type Wallet } from '@arkade-os/sdk'
import { selectSpendInputs } from './coin_select'
import { makeExitCostOracle } from './exit/cost_oracle'

// The single funnel for coins leaving the wallet offchain, and the hot-pocket
// shape that makes the funnel's job easy (SEND_DESIGN.md §9). Every rail that
// spends VTXOs offchain goes through `sendSelected`; nothing calls
// `wallet.send` / `wallet.sendBitcoin` directly any more, because the SDK's own
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

export interface SpendDeps {
  wallet: Wallet
  db: Database
  /** arkd getInfo — `dust` sizes the change guard, `deprecatedSigners` gates explicit selection. */
  arkInfo: Pick<ArkInfo, 'dust' | 'deprecatedSigners'>
}

/**
 * VTXOs an offchain spend can actually consume: the SDK's selection pool
 * (`withRecoverable: false` drops swept/expired) minus fresh sub-dust, which
 * sits in that pool but can only be consumed by a settlement round.
 */
export async function spendablePool(wallet: Wallet, dust: bigint): Promise<ExtendedVirtualCoin[]> {
  const vtxos = await wallet.getVtxos({ withRecoverable: false })
  return vtxos.filter((v) => !isSubdust(v, dust))
}

export const poolSats = (pool: ExtendedVirtualCoin[]): number => pool.reduce((n, v) => n + v.value, 0)

/**
 * Explicit selection is unsafe to use while the ASP advertises deprecated
 * signers: `Wallet.sendBitcoin({ selectedVtxos })` skips the
 * `pendingRecoveryOutpoints()` filter that `Wallet.send` applies, and that
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
export async function sendSelected(
  deps: SpendDeps,
  params: { address: string; amount: number; pool?: ExtendedVirtualCoin[] },
): Promise<string> {
  const dust = Number(deps.arkInfo.dust)
  const pool = params.pool ?? (await spendablePool(deps.wallet, deps.arkInfo.dust))

  if (!explicitSelectionSafe(deps.arkInfo)) {
    console.warn('spend: ASP advertises deprecated signers — deferring coin choice to the SDK')
    return deps.wallet.send({ address: params.address, amount: params.amount })
  }

  const selected = selectSpendInputs(pool, {
    target: params.amount,
    changeDust: dust,
    exitCostOf: makeExitCostOracle(deps.db),
  })
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

  // sendBitcoin is @deprecated in favour of send(), but `selectedVtxos` is the
  // ONLY explicit-selection surface the SDK exposes — send(...recipients) always
  // runs its own selector. The branch is first-class (tx lock, dust-aware
  // change scripts, the same _submitOffchainSpend), so this is a supported call,
  // not a back door. If an SDK bump drops it, the unit test pins the contract.
  return deps.wallet.sendBitcoin({
    address: params.address,
    amount: params.amount,
    selectedVtxos: selected,
  })
}

/**
 * Whether a wear pocket needs carving out of `pool`. True only when no coin is
 * already small enough to serve as one AND the wallet can spare it while
 * leaving a cold coin above dust.
 *
 * One threshold, no second magic number: a coin at or under HOT_POCKET_SATS
 * IS the pocket. A worn-down pocket therefore never triggers a re-split — that
 * is intended, see HOT_POCKET_SATS.
 */
export function needsHotPocket(pool: ExtendedVirtualCoin[], dust: number): boolean {
  if (pool.some((v) => v.value <= HOT_POCKET_SATS)) return false
  return pool.some((v) => v.value >= HOT_POCKET_SATS + dust)
}

/**
 * Carve one wear pocket out of the consolidated wallet: a self-send that leaves
 * `[hot, cold]` instead of a single coin.
 *
 * Why not two outputs on the settle itself (which would leave both at batch-leaf
 * depth instead of one hop): reproducing what no-arg `wallet.settle()` does
 * would mean reimplementing its private internals — boarding-UTXO gathering,
 * per-input fee filtering, MAX_VTXOS_PER_SETTLEMENT, the dust check — against
 * SDK-internal helpers that aren't exported. Losing boarding absorption on a
 * refresh is a far worse failure than one extra hop, and that hop is a FIXED
 * cost paid once per refresh cycle, not an accumulating one.
 *
 * Best-effort by construction: a failure here leaves a perfectly good
 * consolidated wallet, so it is logged and swallowed by callers.
 */
export async function splitHotPocket(deps: SpendDeps): Promise<string | undefined> {
  const dust = Number(deps.arkInfo.dust)
  const pool = await spendablePool(deps.wallet, deps.arkInfo.dust)
  if (!needsHotPocket(pool, dust)) return undefined

  // Plain wallet.send on purpose: its selector takes the largest coin, which
  // right after a consolidate-all is the one we want to split.
  const txid = await deps.wallet.send({
    address: await deps.wallet.getAddress(),
    amount: HOT_POCKET_SATS,
  })
  console.log(
    `hot pocket: carved ${HOT_POCKET_SATS} sats off the consolidated VTXO (arkTxid ${txid}) — wear now concentrates there`,
  )
  return txid
}
