import { describe, expect, test } from 'bun:test'
import { selectSpendInputs, type SelectionCoin } from '../../src/coin_select'

// The policy under test is an economic one, so every case below is written as
// "which coin does the wallet lose the least by spending". The objective it
// implements: P = Σ max(0, vᵢ − cᵢ), minimize ΔP.

interface Coin extends SelectionCoin {
  cost: number
}
let n = 0
const coin = (value: number, cost = 0): Coin => ({ txid: `t${n++}`.padEnd(64, '0'), vout: 0, value, cost })
const exitCostOf = (c: Coin): number => c.cost

const DUST = 330
const ids = (cs: Coin[]): number[] => cs.map((c) => c.value)

describe('selectSpendInputs — single-coin preference', () => {
  test('prefers one covering coin over a merge that would also work', () => {
    // Merging is the thing to avoid: the change would inherit BOTH chains.
    const one = coin(5_000)
    const picked = selectSpendInputs([coin(600), coin(600), one], {
      target: 1_000,
      changeDust: DUST,
      exitCostOf,
    })
    expect(picked).toEqual([one])
  })

  test('among covering coins, spends the one with the lowest n = v − c', () => {
    // The hot pocket: worn past the point where exit recovers anything, so
    // chaining it further destroys nothing. The cold coin stays pristine.
    const hot = coin(2_000, 6_000) // n = 0 (written off)
    const cold = coin(100_000, 200) // n = 99_800
    expect(selectSpendInputs([cold, hot], { target: 500, changeDust: DUST, exitCostOf })).toEqual([hot])
  })

  test('does NOT reach for the dirtiest coin when that coin is also huge', () => {
    // "spend the dirtiest" is the wrong rule: it eats a coin whose value is
    // still fully recoverable. n = v − c is what tracks the actual loss.
    const smallClean = coin(1_000, 0) // n = 1_000
    const bigDirty = coin(100_000, 20_000) // n = 80_000, but cost is the highest
    expect(
      selectSpendInputs([bigDirty, smallClean], { target: 500, changeDust: DUST, exitCostOf }),
    ).toEqual([smallClean])
  })

  test('ties on n break toward the smaller coin (wear keeps landing in one pocket)', () => {
    const small = coin(1_500, 1_500) // n = 0
    const large = coin(9_000, 9_000) // n = 0
    expect(selectSpendInputs([large, small], { target: 500, changeDust: DUST, exitCostOf })).toEqual([small])
  })
})

describe('selectSpendInputs — sub-dust change band', () => {
  test('rejects a coin whose change would be stranded sub-dust', () => {
    // 1000 − 800 = 200 < dust: wallet.sendBitcoin would mint that as a sub-dust
    // vtxo, unusable until a round. Better to report "can't compose" than to
    // silently strand value.
    expect(selectSpendInputs([coin(1_000)], { target: 800, changeDust: DUST, exitCostOf })).toEqual([])
  })

  test('accepts an exact-value coin (no change at all)', () => {
    const exact = coin(800)
    expect(selectSpendInputs([exact], { target: 800, changeDust: DUST, exitCostOf })).toEqual([exact])
  })

  test('accumulation keeps going THROUGH the band rather than stopping in it', () => {
    // 500+500 = 1000 lands inside (800, 1130) → not covered; a third escapes it.
    const picked = selectSpendInputs([coin(500), coin(500), coin(500)], {
      target: 800,
      changeDust: DUST,
      exitCostOf,
    })
    expect(picked.length).toBe(3)
  })

  test('whole-input mode (no changeDust) has no band — any sum ≥ target covers', () => {
    // The atomic sub-dust funding spends coins WHOLE: no change output exists,
    // so there is nothing to strand.
    const small = coin(400)
    expect(selectSpendInputs([coin(100_000), small], { target: 331, exitCostOf })).toEqual([small])
  })
})

describe('selectSpendInputs — forced merges', () => {
  test('leaves written-off coins OUT of a merge', () => {
    // THE contamination case. Dragging the n≤0 coin in would force the merged
    // change to carry its exit cost forever — destroying |n| = c − v extra.
    const hot = coin(2_000, 6_000) // n = 0
    const a = coin(3_000, 100)
    const b = coin(3_000, 100)
    const picked = selectSpendInputs([hot, a, b], { target: 5_000, changeDust: DUST, exitCostOf })
    expect(picked).not.toContain(hot)
    expect(ids(picked).reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(5_000 + DUST)
  })

  test('a big clean coin alone still beats any merge (point 7: never fold hot into cold)', () => {
    const hot = coin(2_000, 6_000)
    const cold = coin(100_000, 200)
    expect(selectSpendInputs([hot, cold], { target: 5_000, changeDust: DUST, exitCostOf })).toEqual([cold])
  })

  test('pulls a written-off coin in only when the solvent ones cannot cover', () => {
    const hot = coin(2_000, 6_000) // n = 0
    const a = coin(3_000, 100)
    const picked = selectSpendInputs([hot, a], { target: 4_500, changeDust: DUST, exitCostOf })
    expect(picked).toContain(hot)
    expect(picked).toContain(a)
  })

  test('merges cheapest-chain-first, biggest-first among equals (fewest inputs)', () => {
    // Deliberately no single coin covers 6_000 + dust, so the merge path runs.
    const dirty = coin(5_000, 400)
    const cleanBig = coin(4_000, 100)
    const cleanSmall = coin(3_000, 100)
    const picked = selectSpendInputs([dirty, cleanSmall, cleanBig], {
      target: 6_000,
      changeDust: DUST,
      exitCostOf,
    })
    expect(picked).toEqual([cleanBig, cleanSmall])
  })
})

describe('selectSpendInputs — boundaries', () => {
  test('empty pool and an uncoverable target both return []', () => {
    expect(selectSpendInputs([], { target: 100, changeDust: DUST, exitCostOf })).toEqual([])
    expect(selectSpendInputs([coin(100), coin(100)], { target: 5_000, changeDust: DUST, exitCostOf })).toEqual([])
  })

  test('deterministic: input order never changes the answer', () => {
    const pool = [coin(1_000, 900), coin(1_000, 900), coin(4_000, 0), coin(2_500, 2_500)]
    const forward = selectSpendInputs(pool, { target: 6_000, changeDust: DUST, exitCostOf })
    const reversed = selectSpendInputs([...pool].reverse(), { target: 6_000, changeDust: DUST, exitCostOf })
    expect(forward.map((c) => c.txid)).toEqual(reversed.map((c) => c.txid))
  })

  test('an all-unknown-cost pool degrades to plain single-coin-preferred selection', () => {
    // The oracle answers 0 for coins with no vault proofs, so nothing is ever
    // written off and every coin looks pristine — selection must still work.
    const zero = (): number => 0
    const small = coin(1_000)
    const picked = selectSpendInputs([coin(50_000), small], { target: 500, changeDust: DUST, exitCostOf: zero })
    expect(picked).toEqual([small]) // lowest n = smallest value
  })
})
