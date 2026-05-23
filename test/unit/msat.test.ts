import { describe, expect, test } from 'bun:test'
import { msatsToSats, satsToMsats } from '../../src/lib/msat'

describe('msat conversion', () => {
  test('satsToMsats multiplies by 1000', () => {
    expect(satsToMsats(0)).toBe(0)
    expect(satsToMsats(1)).toBe(1000)
    expect(satsToMsats(21_000_000)).toBe(21_000_000_000)
  })

  test('msatsToSats flags exact multiples of 1000', () => {
    expect(msatsToSats(0)).toEqual({ sats: 0, exact: true })
    expect(msatsToSats(1000)).toEqual({ sats: 1, exact: true })
    expect(msatsToSats(123_000)).toEqual({ sats: 123, exact: true })
  })

  test('msatsToSats floors and flags non-exact remainders', () => {
    // Critical for make_invoice: clients sending sub-sat msat amounts must
    // get OTHER, not a silent truncation.
    expect(msatsToSats(999)).toEqual({ sats: 0, exact: false })
    expect(msatsToSats(1500)).toEqual({ sats: 1, exact: false })
    expect(msatsToSats(1001)).toEqual({ sats: 1, exact: false })
  })

  test('round-trip preserves whole-sat amounts', () => {
    for (const s of [1, 7, 21_000, 1_000_000]) {
      expect(msatsToSats(satsToMsats(s))).toEqual({ sats: s, exact: true })
    }
  })
})
