import { describe, expect, test } from 'bun:test'
import type { ArkInfo, ExtendedVirtualCoin } from '@arkade-os/sdk'
import {
  classifyDestination,
  classifyVtxos,
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
