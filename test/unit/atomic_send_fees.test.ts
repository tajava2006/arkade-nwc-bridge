import { describe, expect, test } from 'bun:test'
import { lnDrainInvoiceSat, maxSendFeeSats, sendFeeSats } from '../../src/atomic/fees'
import { routingFeeLimitSat } from '../../subdustd/api/send'

// D11: atomic sends carry any amount, so the fee rules have to hold past dust.
describe('atomic send fees at any amount', () => {
  test("the bridge's cap is 1% of a, never below dust", () => {
    expect(maxSendFeeSats(21, 330)).toBe(330)
    expect(maxSendFeeSats(33_000, 330)).toBe(330)
    expect(maxSendFeeSats(100_000, 330)).toBe(1_000)
    expect(maxSendFeeSats(4_294_967, 330)).toBe(42_950)
  })

  test("subdustd's 0.5% always fits under the bridge's cap", () => {
    for (const a of [1, 21, 329, 330, 1_000, 66_000, 66_001, 100_000, 4_294_967, 50_000_000]) {
      expect(sendFeeSats(a, 0.5)).toBeLessThanOrEqual(maxSendFeeSats(a, 330))
    }
  })

  test('routing budget: the 121-sat floor up to 34,571 sats, then 0.35% — below the 0.5% fee', () => {
    expect(routingFeeLimitSat(21)).toBe(121)
    expect(routingFeeLimitSat(34_571)).toBe(121)
    expect(routingFeeLimitSat(34_572)).toBe(122)
    expect(routingFeeLimitSat(1_000_000)).toBe(3_500)
    expect(routingFeeLimitSat(1_000_000)).toBeLessThan(sendFeeSats(1_000_000, 0.5))
  })
})

// SM-90: Lightning empties the wallet when the invoice plus its fee is the
// whole spendable total — the funding then leaves no change at all.
describe('lnDrainInvoiceSat', () => {
  test('finds the invoice whose send costs exactly the total', () => {
    expect(lnDrainInvoiceSat(10_000, 0.5)).toBe(9_950) // 9,950 + ceil(49.75) = 10,000
    expect(lnDrainInvoiceSat(330, 0.5)).toBe(328) // 328 + 2: one dust coin
    expect(lnDrainInvoiceSat(5_000, 0)).toBe(5_000)
  })

  test('totals the rounded-up fee skips have no exact invoice', () => {
    // At 0.5% the cost goes 200 → 201 → 203: 202 is never a send's cost.
    expect(lnDrainInvoiceSat(201, 0.5)).toBe(200)
    expect(lnDrainInvoiceSat(202, 0.5)).toBeNull()
    expect(lnDrainInvoiceSat(203, 0.5)).toBe(201)
    expect(lnDrainInvoiceSat(0, 0.5)).toBeNull()
  })

  test('every answer is exact and the largest such invoice', () => {
    for (const pct of [0.5, 1, 0.1]) {
      for (let total = 1; total <= 3_000; total++) {
        const x = lnDrainInvoiceSat(total, pct)
        if (x === null) {
          for (let y = 1; y <= total; y++) expect(y + sendFeeSats(y, pct)).not.toBe(total)
        } else {
          expect(x + sendFeeSats(x, pct)).toBe(total)
          expect(x + 1 + sendFeeSats(x + 1, pct)).toBeGreaterThan(total)
        }
      }
    }
  })
})
