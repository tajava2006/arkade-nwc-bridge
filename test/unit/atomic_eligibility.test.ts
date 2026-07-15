import { describe, expect, test } from 'bun:test'
import type { VirtualCoin } from '@arkade-os/sdk'
import { isEligibleFundingInput, selectFundingInput } from '../../src/atomic/eligibility'

const T = 1893456000n // refund deadline (secs)
const MARGIN = 3600
const DUST = 330
const FLOOR = Number(T) + MARGIN // batch expiry must clear this

function fakeVtxo(o: { value: number; state?: string; batchExpiry?: number; isSpent?: boolean }): VirtualCoin {
  return {
    txid: 'aa'.repeat(32),
    vout: 0,
    value: o.value,
    status: { confirmed: true },
    createdAt: new Date(),
    script: '',
    isUnrolled: false,
    isSpent: o.isSpent ?? false,
    virtualStatus: { state: o.state ?? 'settled', batchExpiry: o.batchExpiry },
  } as unknown as VirtualCoin
}

const args = { dust: DUST, refundLocktime: T, marginSecs: MARGIN }

describe('isEligibleFundingInput', () => {
  test('accepts a regular, long-lived, unspent vtxo', () => {
    expect(isEligibleFundingInput(fakeVtxo({ value: 1000, batchExpiry: FLOOR + 1000 }), args)).toEqual({ eligible: true })
  })

  test('normalizes a millisecond batchExpiry (wallet model unit)', () => {
    const ms = (FLOOR + 1000) * 1000
    expect(isEligibleFundingInput(fakeVtxo({ value: 1000, batchExpiry: ms }), args).eligible).toBe(true)
  })

  test('rejects a spent vtxo', () => {
    expect(isEligibleFundingInput(fakeVtxo({ value: 1000, batchExpiry: FLOOR + 1000, isSpent: true }), args).eligible).toBe(false)
  })

  test('rejects a swept (recoverable) vtxo', () => {
    const r = isEligibleFundingInput(fakeVtxo({ value: 1000, batchExpiry: FLOOR + 1000, state: 'swept' }), args)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/recoverable/)
  })

  test('rejects a sub-dust vtxo', () => {
    const r = isEligibleFundingInput(fakeVtxo({ value: 100, batchExpiry: FLOOR + 1000 }), args)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/sub-dust/)
  })

  test('rejects a vtxo whose batch expires before T + margin', () => {
    const r = isEligibleFundingInput(fakeVtxo({ value: 1000, batchExpiry: FLOOR - 1 }), args)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/swept mid-swap/)
  })

  test('rejects a vtxo with no batchExpiry', () => {
    expect(isEligibleFundingInput(fakeVtxo({ value: 1000 }), args).eligible).toBe(false)
  })
})

describe('selectFundingInput', () => {
  const sel = { ...args, amount: 21 } // change-regular threshold = dust + a = 351

  test('prefers the smallest vtxo that yields a regular change', () => {
    const vtxos = [
      fakeVtxo({ value: 340, batchExpiry: FLOOR + 1000 }), // eligible but change would be sub-dust
      fakeVtxo({ value: 500, batchExpiry: FLOOR + 1000 }), // yields regular change, smallest such
      fakeVtxo({ value: 9000, batchExpiry: FLOOR + 1000 }),
    ]
    expect(selectFundingInput(vtxos, sel)?.value).toBe(500)
  })

  test('falls back to the smallest eligible when none yields a regular change', () => {
    const vtxos = [fakeVtxo({ value: 340, batchExpiry: FLOOR + 1000 }), fakeVtxo({ value: 335, batchExpiry: FLOOR + 1000 })]
    expect(selectFundingInput(vtxos, sel)?.value).toBe(335)
  })

  test('returns undefined when nothing is eligible', () => {
    const vtxos = [fakeVtxo({ value: 100, batchExpiry: FLOOR + 1000 }), fakeVtxo({ value: 1000, batchExpiry: FLOOR - 1 })]
    expect(selectFundingInput(vtxos, sel)).toBeUndefined()
  })
})
