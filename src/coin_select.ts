// Exit-cost-aware coin selection (SEND_DESIGN.md §9). ONE policy for every
// offchain spend the bridge makes — plain Ark sends, dust+ submarine swaps, and
// the atomic sub-dust funding — because they all move the same coins and pay
// the same price for getting it wrong.
//
// WHY THIS EXISTS
//
// A vtxo's unilateral-exit cost is the whole chain of Arkade txs from its last
// batch-leaf ancestor down to it (exit/estimate.ts sums every entry of the
// indexer's chain DAG). Two facts follow, and they are what the policy is
// built on:
//
//   1. An offchain tx's change output inherits the exit chains of ALL its
//      inputs, unioned. Merging is additive and there is no offchain operation
//      that ever shrinks it. Spend a 53-hop coin together with a pristine one
//      and the pristine value is now 53 hops deep too — permanently.
//   2. A settlement round resets it to zero, no matter how deep the inputs
//      were: the outputs are fresh tree leaves.
//
// So: MERGE ONLY INSIDE A ROUND. Offchain, prefer to spend exactly one coin.
//
// WHICH ONE — the objective
//
// Value a wallet at what unilateral exit would actually recover:
//   P = Σ max(0, vᵢ − cᵢ)   (v = value, c = exit cost, n := v − c)
// Spending A from a single coin i destroys
//   ΔP = n_i ≥ A+h  →  A + h        (h = one hop; the floor, unavoidable)
//        0 < n_i < A+h  →  n_i      (less than the floor)
//        n_i ≤ 0        →  0        (free: the coin was already written off)
// which is minimized by ascending n. Ascending *cost* would be wrong (it burns
// down a huge dirty coin); ascending *value* would be wrong too (it burns a
// small pristine coin whose value is fully recoverable). n = v − c is the
// metric that actually tracks what the wallet loses.
//
// And merging a net-negative coin into a positive one destroys exactly
// |n| = c − v extra — the pool is forced to pay that coin's exit cost to reach
// its value. Hence step 2: when a merge is unavoidable, leave the written-off
// coins OUT of it.
//
// The SDK's own selector sorts (batch expiry asc, value DESC), i.e. it reaches
// for the biggest coin first. Under a two-coin hot/cold wallet that means every
// send dirties the cold coin — the exact opposite of concentrating wear on one
// pocket, which is why the spend paths select explicitly instead.

export interface SelectionCoin {
  txid: string
  vout: number
  value: number
}

export interface SelectOptions<T extends SelectionCoin> {
  /** Sats the chosen inputs must cover. */
  target: number
  /**
   * Dust floor for the change this spend will leave behind. When set, a total
   * landing strictly between `target` and `target + changeDust` is rejected —
   * that change is minted as a sub-dust vtxo, stranded until a round. Omit for
   * whole-input spends that leave no change (atomic sub-dust funding).
   */
  changeDust?: number
  /** Exit cost (sats) at the reference rate. Unknown ⇒ 0; see exit/cost_oracle.ts. */
  exitCostOf: (coin: T) => number
}

/**
 * Pick inputs covering `target`, minimizing destroyed exit value.
 *
 *   1. a single coin that covers it → the one with the lowest n = v − c
 *      (ties: the smaller coin, so wear keeps landing on the same pocket)
 *   2. otherwise merge, but only across coins that are still worth something
 *      (n > 0), cheapest chain first — every written-off coin dragged into a
 *      merge costs the pool its own exit cost
 *   3. only if that cannot cover it, merge everything
 *
 * Returns [] when the whole pool cannot cover `target`. Deterministic: every
 * ordering is fully broken down to (txid, vout).
 */
export function selectSpendInputs<T extends SelectionCoin>(coins: T[], opts: SelectOptions<T>): T[] {
  const { target, changeDust, exitCostOf } = opts

  // A total inside the sub-dust change band is not "covered" — accumulation
  // must keep going rather than mint a stranded remainder.
  const covers = (sum: number): boolean =>
    changeDust === undefined ? sum >= target : sum === target || sum >= target + changeDust

  const net = (c: T): number => Math.max(0, c.value - exitCostOf(c))
  const outpoint = (c: T): string => `${c.txid}:${c.vout}`

  const singles = coins.filter((c) => covers(c.value))
  if (singles.length > 0) {
    return [
      singles.reduce((best, c) => {
        const d = net(c) - net(best) || c.value - best.value || outpoint(c).localeCompare(outpoint(best))
        return d < 0 ? c : best
      }),
    ]
  }

  // Cheapest chain first so the merged change is as cheap to exit as possible;
  // bigger first among equals so a forced merge takes the fewest inputs.
  const byChainThenSize = (a: T, b: T): number =>
    exitCostOf(a) - exitCostOf(b) || b.value - a.value || outpoint(a).localeCompare(outpoint(b))

  const accumulate = (pool: T[]): T[] | undefined => {
    const picked: T[] = []
    let sum = 0
    for (const c of pool) {
      picked.push(c)
      sum += c.value
      if (covers(sum)) return picked
    }
    return undefined
  }

  const worthKeeping = coins.filter((c) => net(c) > 0).sort(byChainThenSize)
  return accumulate(worthKeeping) ?? accumulate([...coins].sort(byChainThenSize)) ?? []
}
