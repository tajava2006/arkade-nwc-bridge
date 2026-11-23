import { describe, expect, test } from 'bun:test'
import { maxSendFeeSats } from '../../src/atomic/send'
import { routingFeeLimitSat, sendFeeSats } from '../../subdustd/api/send'

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
