import { describe, expect, test } from 'bun:test'
import type { ArkInfo, ExtendedVirtualCoin } from '@arkade-os/sdk'
import {
  classifyDestination,
  classifyVtxos,
  offboardDustChange,
  offboardFeeSat,
  offboardMaxSat,
} from '../../src/send'

const DUST = 330n

function vtxo(opts: {
  value: number
  state?: string
  isSpent?: boolean
  batchExpiry?: number
}): ExtendedVirtualCoin {
  return {
    txid: 'aa'.repeat(32),
    vout: 0,
    value: opts.value,
    isSpent: opts.isSpent ?? false,
    createdAt: new Date(),
    virtualStatus: {
      state: opts.state ?? 'settled',
      batchExpiry: opts.batchExpiry ?? Date.now() + 30 * 86_400_000,
    },
  } as unknown as ExtendedVirtualCoin
}

function arkInfo(intentFee: Record<string, string> = {}): ArkInfo {
  return { dust: DUST, fees: { intentFee, txFeeRate: '1' } } as unknown as ArkInfo
}

describe('classifyVtxos', () => {
  test('buckets by rail-availability and sums totals', () => {
    const b = classifyVtxos(
      [
        vtxo({ value: 1000 }), // offchain-spendable
        vtxo({ value: 100 }), // sub-dust (< 330)
        vtxo({ value: 5000, state: 'swept' }), // recoverable
        vtxo({ value: 9999, isSpent: true }), // excluded (spent)
      ],
      DUST,
    )
    expect(b.spendable.length).toBe(1)
    expect(b.subdust.length).toBe(1)
    expect(b.recoverable.length).toBe(1)
    expect(b.spendableSat).toBe(1000)
    expect(b.subdustSat).toBe(100)
    expect(b.recoverableSat).toBe(5000)
    expect(b.roundTotalSat).toBe(6100)
  })

  test('expired (not swept) is recoverable, not spendable', () => {
    const b = classifyVtxos([vtxo({ value: 1000, batchExpiry: Date.now() - 86_400_000 })], DUST)
    expect(b.spendable.length).toBe(0)
    expect(b.recoverable.length).toBe(1)
  })
})

describe('offboard fee + max', () => {
  test('fee is 0 with empty intent-fee program (our policy)', () => {
    expect(offboardFeeSat(arkInfo(), 5000)).toBe(0)
  })

  test('flat onchainOutput program is applied', () => {
    expect(offboardFeeSat(arkInfo({ onchainOutput: '1000.0' }), 5000)).toBe(1000)
  })

  test('max = full round total (incl. sub-dust + swept) minus fee', () => {
    const b = classifyVtxos(
      [vtxo({ value: 5000 }), vtxo({ value: 100 }), vtxo({ value: 2000, state: 'swept' })],
      DUST,
    ) // roundTotal = 7100
    expect(offboardMaxSat(arkInfo({ onchainOutput: '1000.0' }), b)).toBe(6100)
  })

  test('max is null when total minus fee is below dust (stuck)', () => {
    const b = classifyVtxos([vtxo({ value: 400 })], DUST) // total 400
    expect(offboardMaxSat(arkInfo({ onchainOutput: '100.0' }), b)).toBeNull() // 300 < 330
  })
})

describe('offboardDustChange', () => {
  // The 2026-08-01 shape: 10000 + 300×4 = 11200 total, flat 1000 output fee.
  const info = arkInfo({ onchainOutput: '1000.0' })
  const buckets = () =>
    classifyVtxos(
      [
        vtxo({ value: 10000 }),
        vtxo({ value: 300 }),
        vtxo({ value: 300 }),
        vtxo({ value: 300 }),
        vtxo({ value: 300 }),
      ],
      DUST,
    )

  test('amount in the top-dust window is blocked with a suggestion', () => {
    // gross 10100 + 1000 = 11100 → change 100 ∈ (0, 330)
    const hit = offboardDustChange(info, buckets(), 10100)
    expect(hit).not.toBeNull()
    expect(hit!.changeSat).toBe(100)
    // largest recipient keeping a ≥ dust change: 11200 − 330 − 1000
    expect(hit!.maxKeepingChangeSat).toBe(9870)
  })

  test('change exactly at dust passes', () => {
    expect(offboardDustChange(info, buckets(), 9870)).toBeNull() // change 330
  })

  test('exact drain (change 0) passes', () => {
    expect(offboardDustChange(info, buckets(), 10200)).toBeNull() // gross 11200 = total
  })

  test('insufficient funds is not this guard (falls through to the SDK)', () => {
    expect(offboardDustChange(info, buckets(), 10300)).toBeNull() // gross > total
  })

  test('zero-fee program (our policy) still detects the window', () => {
    const hit = offboardDustChange(arkInfo(), classifyVtxos([vtxo({ value: 500 })], DUST), 400)
    expect(hit).not.toBeNull()
    expect(hit!.changeSat).toBe(100)
    expect(hit!.maxKeepingChangeSat).toBe(170) // 500 − 330
  })

  test('no fitting amount → null suggestion (Max is the only way out)', () => {
    const b = classifyVtxos([vtxo({ value: 400 })], DUST)
    const hit = offboardDustChange(arkInfo({ onchainOutput: '100.0' }), b, 50)
    expect(hit).not.toBeNull() // change 250 < 330
    expect(hit!.maxKeepingChangeSat).toBeNull() // 400 − 330 − 100 < 0
  })
})

describe('classifyDestination', () => {
  test('empty → null', () => {
    expect(classifyDestination('   ')).toBeNull()
  })

  test('bolt11 invoice → lightning', () => {
    // Standard BOLT11 test vector (mainnet, 2500u).
    const invoice =
      'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'
    expect(classifyDestination(invoice)).toBe('lightning')
  })

  test('non-invoice, non-Ark string → onchain (offboard validates it later)', () => {
    expect(classifyDestination('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe('onchain')
  })
})
