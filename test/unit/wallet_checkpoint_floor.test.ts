import { describe, expect, test } from 'bun:test'
import { MIN_CHECKPOINT_EXIT_DELAY_SECONDS } from '../../src/wallet'

// The scenario under guard: arkd's stock 24h checkpoint exit delay (86400s)
// travels to us inside a BIP-68 relative timelock, which counts in 512-second
// units. 86400 is not a multiple of 512, so the script carries floor(168.75)
// = 168 units and decodes back as 86016s. SDK 0.4.62 began enforcing a
// mainnet floor of exactly 86400s against that decoded value, so a stock ASP
// boots the bridge straight into degraded mode:
//
//   boot: degraded — checkpoint exit delay rejected: 86016 seconds is below
//   the 86400s floor
//
// (Observed on the operator machine, 2026-09-05, right after the SDK bump.)
const SECONDS_PER_TIMELOCK_UNIT = 512n
const ARKD_NOMINAL_CHECKPOINT_EXIT_DELAY = 86400n

describe('checkpoint exit delay floor', () => {
  test('is representable — a whole number of 512-second timelock units', () => {
    expect(MIN_CHECKPOINT_EXIT_DELAY_SECONDS % SECONDS_PER_TIMELOCK_UNIT).toBe(0n)
  })

  test("matches what arkd's nominal 24h actually encodes to", () => {
    const encoded =
      (ARKD_NOMINAL_CHECKPOINT_EXIT_DELAY / SECONDS_PER_TIMELOCK_UNIT) * SECONDS_PER_TIMELOCK_UNIT
    expect(MIN_CHECKPOINT_EXIT_DELAY_SECONDS).toBe(encoded)
  })

  // The floor may only ever move by the encoding's rounding. Anything lower
  // would be a real policy concession: a short checkpoint delay shrinks the
  // window we have to react during a unilateral exit, and this constant is
  // the only thing rejecting an ASP that advertises one.
  test('concedes nothing beyond the rounding', () => {
    expect(
      ARKD_NOMINAL_CHECKPOINT_EXIT_DELAY - MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
    ).toBeLessThan(SECONDS_PER_TIMELOCK_UNIT)
  })
})
