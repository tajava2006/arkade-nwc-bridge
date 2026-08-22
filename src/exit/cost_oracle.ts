import type { Database } from 'bun:sqlite'
import { estimateExit } from './estimate'
import type { SelectionCoin } from '../coin_select'

/** All the oracle needs to price a coin — value is the caller's business. */
export type ExitCostKey = Pick<SelectionCoin, 'txid' | 'vout'>

/**
 * Fee rate the SELECTION policy prices unilateral exit at (coin_select.ts).
 *
 * Deliberately a constant, not `exitEngine.feeRate()`: coin choice runs on the
 * send path and must be deterministic, offline (degraded mode has no esplora)
 * and unit-testable. This is not a prediction of what an exit would cost — it
 * is the policy knob "at what assumed exit cost do we treat a coin as written
 * off", which is what decides whether a coin is free to keep spending from.
 * Ordering between coins barely moves with it; only the n ≤ 0 threshold does.
 */
export const EXIT_REF_RATE_SAT_VB = 5

/**
 * Exit cost (sats) per coin, memoized for one selection pass. Reads the offline
 * proof vault only — no network, no ASP.
 *
 * Unknown ⇒ 0, i.e. "assume pristine". That is the safe direction: a coin whose
 * chain we can't price looks valuable, so the policy avoids spending it and
 * reaches for one we HAVE priced. Nothing is contaminated by that (a
 * single-coin spend contaminates nothing); at worst we fail to concentrate wear
 * as tightly as we could.
 */
export function makeExitCostOracle(db: Database): (coin: ExitCostKey) => number {
  const memo = new Map<string, number>()
  return (coin: ExitCostKey): number => {
    const key = `${coin.txid}:${coin.vout}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    let cost = 0
    try {
      // proofComplete=false means the vault holds only part of the chain, so
      // the number is a floor. A floor still orders coins correctly (a deep
      // chain reads as expensive either way) and never over-writes-off a coin.
      cost = estimateExit(db, coin.txid, coin.vout, EXIT_REF_RATE_SAT_VB)?.totalFeeSat ?? 0
    } catch {
      cost = 0 // a corrupt vault row must not break the send path
    }
    memo.set(key, cost)
    return cost
  }
}
