import { describe, expect, test } from 'bun:test'
import type { VirtualCoin } from '@arkade-os/sdk'
import { isEligibleFundingInput, selectFundingInputs } from '../../src/atomic/eligibility'

const T = 1893456000n // refund deadline (secs)
const MARGIN = 3600
const DUST = 330
const FLOOR = Number(T) + MARGIN // batch expiry must clear this

// SDK 0.5 coin shape: flat flags + `expiresAt` (a Date) — the 0.4
// `virtualStatus { state, batchExpiry }` object is gone.
function fakeVtxo(o: {
  value: number
  expiresAt?: number // seconds
  isSpent?: boolean
  isSwept?: boolean
  isUnrolled?: boolean
  settledBy?: string
  isPreconfirmed?: boolean
}): VirtualCoin {
  return {
    txid: 'aa'.repeat(32),
    vout: 0,
    value: o.value,
    status: { confirmed: !o.isSwept && !o.isPreconfirmed },
    createdAt: new Date(),
    script: '',
    isUnrolled: o.isUnrolled ?? false,
    isSpent: o.isSpent ?? false,
    isSwept: o.isSwept ?? false,
    isPreconfirmed: o.isPreconfirmed ?? false,
    settledBy: o.settledBy,
    expiresAt: o.expiresAt === undefined ? undefined : new Date(o.expiresAt * 1000),
  } as unknown as VirtualCoin
}

const args = { dust: DUST, refundLocktime: T, marginSecs: MARGIN }

describe('isEligibleFundingInput', () => {
  test('accepts a regular, long-lived, unspent vtxo', () => {
    expect(isEligibleFundingInput(fakeVtxo({ value: 1000, expiresAt: FLOOR + 1000 }), args)).toEqual({ eligible: true })
  })

  test('accepts a preconfirmed (offchain-received, not yet batched) vtxo — it is spendable offchain', () => {
    expect(isEligibleFundingInput(fakeVtxo({ value: 1000, expiresAt: FLOOR + 1000, isPreconfirmed: true }), args).eligible).toBe(true)
  })

  test('rejects a spent vtxo', () => {
    expect(isEligibleFundingInput(fakeVtxo({ value: 1000, expiresAt: FLOOR + 1000, isSpent: true }), args).eligible).toBe(false)
  })

  test('rejects a swept (recoverable) vtxo', () => {
    const r = isEligibleFundingInput(fakeVtxo({ value: 1000, expiresAt: FLOOR + 1000, isSwept: true }), args)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/recoverable/)
  })

  test('rejects a vtxo already past its batch expiry as recoverable, not as merely short-lived', () => {
    const r = isEligibleFundingInput(fakeVtxo({ value: 1000, expiresAt: Math.floor(Date.now() / 1000) - 60 }), args)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/recoverable/)
  })

  test('rejects an unrolled vtxo (left via unilateral exit — arkd refuses it, F24)', () => {
    const r = isEligibleFundingInput(fakeVtxo({ value: 1000, expiresAt: FLOOR + 1000, isUnrolled: true }), args)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/not spendable offchain/)
  })

  test('rejects a vtxo already settled into a batch (settledBy set, spent flag not yet)', () => {
    const r = isEligibleFundingInput(fakeVtxo({ value: 1000, expiresAt: FLOOR + 1000, settledBy: 'bb'.repeat(32) }), args)
    expect(r.eligible).toBe(false)
  })

  test('rejects a sub-dust vtxo', () => {
    const r = isEligibleFundingInput(fakeVtxo({ value: 100, expiresAt: FLOOR + 1000 }), args)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/sub-dust/)
  })

  test('rejects a vtxo whose batch expires before T + margin', () => {
    const r = isEligibleFundingInput(fakeVtxo({ value: 1000, expiresAt: FLOOR - 1 }), args)
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

  test('smallest vtxo already covers V → it funds alone', () => {
    const vtxos = [
      fakeVtxo({ value: 400, expiresAt: ok }), // smallest, ≥ V
      fakeVtxo({ value: 700, expiresAt: ok }),
      fakeVtxo({ value: 9000, expiresAt: ok }),
    ]
    expect(vals(vtxos)).toEqual([400])
  })

  test('ascending accumulation: a below-V vtxo is consumed first, not skipped', () => {
    // [340, 500]: 340 < V=351 → add 500. The old "smallest single covering"
    // shortcut returned [500] and left the 340 fragment behind — the whole
    // point of ascending accumulation is burning that fragment into the swap.
    const vtxos = [fakeVtxo({ value: 340, expiresAt: ok }), fakeVtxo({ value: 500, expiresAt: ok })]
    expect(vals(vtxos)).toEqual([340, 500])
  })

  test('accumulates the smallest coins until V is covered', () => {
    const vtxos = [
      fakeVtxo({ value: 340, expiresAt: ok }),
      fakeVtxo({ value: 330, expiresAt: ok }),
      fakeVtxo({ value: 335, expiresAt: ok }),
    ]
    expect(vals(vtxos)).toEqual([330, 335]) // ascending, stops at coverage
  })

  test('one below-V vtxo and no partner → [] (operator tops up)', () => {
    expect(vals([fakeVtxo({ value: 340, expiresAt: ok })])).toEqual([])
  })

  test('[] when nothing is eligible', () => {
    const vtxos = [fakeVtxo({ value: 100, expiresAt: ok }), fakeVtxo({ value: 1000, expiresAt: FLOOR - 1 })]
    expect(vals(vtxos)).toEqual([])
  })

  // The 2026-07-17 mainnet mini-wallet: [669, 330], a=14 (V=344). Ascending:
  // 330 < 344 → 669 joins → both spent whole, change consolidates them to one.
  test('mainnet scenario: [669, 330] with a=14 consumes both ascending', () => {
    const vtxos = [fakeVtxo({ value: 669, expiresAt: ok }), fakeVtxo({ value: 330, expiresAt: ok })]
    expect(selectFundingInputs(vtxos, { ...args, amount: 14 }).map((v) => v.value)).toEqual([330, 669])
  })

  // amount = a + fee can cross dust (a=329, fee=2 → V=661 > 2·330), where the
  // old unconditional two-smallest under-covered — the sum check adds a third.
  test('fee edge: two smallest under-cover V → a third is added', () => {
    const vtxos = [
      fakeVtxo({ value: 330, expiresAt: ok }),
      fakeVtxo({ value: 330, expiresAt: ok }),
      fakeVtxo({ value: 331, expiresAt: ok }),
    ]
    expect(selectFundingInputs(vtxos, { ...args, amount: 331 }).map((v) => v.value)).toEqual([330, 330, 331])
  })

  test('fee edge: whole eligible pool cannot cover V → []', () => {
    const vtxos = [fakeVtxo({ value: 330, expiresAt: ok }), fakeVtxo({ value: 330, expiresAt: ok })]
    expect(selectFundingInputs(vtxos, { ...args, amount: 331 })).toEqual([])
  })
})
