import { describe, expect, test } from 'bun:test'
import type { VirtualCoin } from '@arkade-os/sdk'
import { isEligibleFundingInput, selectFundingInputs } from '../../src/atomic/eligibility'

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

describe('selectFundingInputs', () => {
  // dust=330, a=21 → V = 351. Whole-vtxo funding: pick input(s) to spend WHOLE.
  const sel = { ...args, amount: 21 }
  const ok = FLOOR + 1000
  const vals = (vtxos: VirtualCoin[]) => selectFundingInputs(vtxos, sel).map((v) => v.value)

  test('smallest single vtxo that alone covers V → fund it whole', () => {
    const vtxos = [
      fakeVtxo({ value: 400, batchExpiry: ok }), // smallest ≥ V
      fakeVtxo({ value: 700, batchExpiry: ok }),
      fakeVtxo({ value: 9000, batchExpiry: ok }),
    ]
    expect(vals(vtxos)).toEqual([400])
  })

  test('a below-V vtxo is skipped in favour of the smallest single that covers V', () => {
    const vtxos = [fakeVtxo({ value: 340, batchExpiry: ok }), fakeVtxo({ value: 500, batchExpiry: ok })]
    expect(vals(vtxos)).toEqual([500])
  })

  test('no single covers V → combine the two smallest (always ≥ 2·dust > V)', () => {
    const vtxos = [
      fakeVtxo({ value: 340, batchExpiry: ok }),
      fakeVtxo({ value: 330, batchExpiry: ok }),
      fakeVtxo({ value: 335, batchExpiry: ok }),
    ]
    expect(vals(vtxos).sort((x, y) => x - y)).toEqual([330, 335]) // the two smallest
  })

  test('one below-V vtxo and no partner → [] (operator tops up)', () => {
    expect(vals([fakeVtxo({ value: 340, batchExpiry: ok })])).toEqual([])
  })

  test('[] when nothing is eligible', () => {
    const vtxos = [fakeVtxo({ value: 100, batchExpiry: ok }), fakeVtxo({ value: 1000, batchExpiry: FLOOR - 1 })]
    expect(vals(vtxos)).toEqual([])
  })

  // The 2026-07-17 mainnet mini-wallet: [669, 330], a=14 (V=344). 669 covers V
  // on its own → fund it whole (previously the router's amount=V bug skipped it).
  test('mainnet scenario: [669, 330] with a=14 funds the 669 whole', () => {
    const vtxos = [fakeVtxo({ value: 669, batchExpiry: ok }), fakeVtxo({ value: 330, batchExpiry: ok })]
    expect(selectFundingInputs(vtxos, { ...args, amount: 14 }).map((v) => v.value)).toEqual([669])
  })

  // amount = a + fee can cross dust (a=329, fee=2 → V=661 > 2·330), where the
  // old unconditional two-smallest under-covered — the sum check adds a third.
  test('fee edge: two smallest under-cover V → a third is added', () => {
    const vtxos = [
      fakeVtxo({ value: 330, batchExpiry: ok }),
      fakeVtxo({ value: 330, batchExpiry: ok }),
      fakeVtxo({ value: 331, batchExpiry: ok }),
    ]
    expect(selectFundingInputs(vtxos, { ...args, amount: 331 }).map((v) => v.value)).toEqual([330, 330, 331])
  })

  test('fee edge: whole eligible pool cannot cover V → []', () => {
    const vtxos = [fakeVtxo({ value: 330, batchExpiry: ok }), fakeVtxo({ value: 330, batchExpiry: ok })]
    expect(selectFundingInputs(vtxos, { ...args, amount: 331 })).toEqual([])
  })
})
