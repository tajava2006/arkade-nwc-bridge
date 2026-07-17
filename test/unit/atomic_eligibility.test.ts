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
  // dust=330, a=21 → V = 351; regular-change floor = V + dust = 681.
  const sel = { ...args, amount: 21 }
  const ok = FLOOR + 1000

  test('prefers the smallest vtxo that yields a REGULAR change (value ≥ V + dust)', () => {
    const vtxos = [
      fakeVtxo({ value: 400, batchExpiry: ok }), // ≥ V but change 49 is sub-dust
      fakeVtxo({ value: 700, batchExpiry: ok }), // change 349 ≥ dust → regular, smallest such
      fakeVtxo({ value: 9000, batchExpiry: ok }),
    ]
    expect(selectFundingInput(vtxos, sel)?.value).toBe(700)
  })

  test('no regular-change option → prefers an EXACT vtxo (value == V, no change)', () => {
    const vtxos = [fakeVtxo({ value: 400, batchExpiry: ok }), fakeVtxo({ value: 351, batchExpiry: ok })]
    expect(selectFundingInput(vtxos, sel)?.value).toBe(351)
  })

  test('only sub-dust-change vtxos → smallest that still covers V (caller OP_RETURNs the change)', () => {
    const vtxos = [fakeVtxo({ value: 500, batchExpiry: ok }), fakeVtxo({ value: 400, batchExpiry: ok })]
    expect(selectFundingInput(vtxos, sel)?.value).toBe(400)
  })

  // Regression for the mainnet false-funding (2026-07-17): a vtxo BELOW V must
  // never be returned — funding with it builds an unbalanced tx arkd rejects
  // ("input amount is not equal to output amount").
  test('NEVER returns a vtxo below V — undefined when nothing covers V', () => {
    const vtxos = [fakeVtxo({ value: 335, batchExpiry: ok }), fakeVtxo({ value: 340, batchExpiry: ok })]
    expect(selectFundingInput(vtxos, sel)).toBeUndefined()
  })

  test('returns undefined when nothing is eligible', () => {
    const vtxos = [fakeVtxo({ value: 100, batchExpiry: ok }), fakeVtxo({ value: 1000, batchExpiry: FLOOR - 1 })]
    expect(selectFundingInput(vtxos, sel)).toBeUndefined()
  })
})
