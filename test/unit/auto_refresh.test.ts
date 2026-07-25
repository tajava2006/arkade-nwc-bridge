import { describe, expect, test } from 'bun:test'
import type { ExtendedVirtualCoin } from '@arkade-os/sdk'
import {
  AUTO_REFRESH_THRESHOLD_SECONDS,
  autoRefreshPass,
  needsRefresh,
} from '../../src/auto_refresh'
import { VTXO_RENEW_THRESHOLD_SECONDS } from '../../src/wallet'

const DUST = 330n
const THRESHOLD_MS = AUTO_REFRESH_THRESHOLD_SECONDS * 1000

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

const soon = (): number => Date.now() + THRESHOLD_MS / 2
const far = (): number => Date.now() + 30 * 86_400_000

describe('needsRefresh', () => {
  test('dust+ spendable VTXO inside the window triggers', () => {
    expect(needsRefresh([vtxo({ value: 1000, batchExpiry: soon() })], DUST, THRESHOLD_MS)).toBe(true)
  })

  test('everything far from expiry does not', () => {
    expect(
      needsRefresh(
        [vtxo({ value: 1000, batchExpiry: far() }), vtxo({ value: 100, batchExpiry: far() })],
        DUST,
        THRESHOLD_MS,
      ),
    ).toBe(false)
  })

  test('sub-dust near expiry cannot anchor a round on its own', () => {
    expect(needsRefresh([vtxo({ value: 100, batchExpiry: soon() })], DUST, THRESHOLD_MS)).toBe(false)
  })

  test('swept (recoverable) near expiry cannot either', () => {
    expect(
      needsRefresh([vtxo({ value: 5000, state: 'swept', batchExpiry: soon() })], DUST, THRESHOLD_MS),
    ).toBe(false)
  })

  test('already-expired VTXO is past saving — no trigger', () => {
    expect(
      needsRefresh([vtxo({ value: 1000, batchExpiry: Date.now() - 60_000 })], DUST, THRESHOLD_MS),
    ).toBe(false)
  })

  test('spent VTXO is ignored', () => {
    expect(
      needsRefresh([vtxo({ value: 1000, isSpent: true, batchExpiry: soon() })], DUST, THRESHOLD_MS),
    ).toBe(false)
  })

  test('empty wallet is idle', () => {
    expect(needsRefresh([], DUST, THRESHOLD_MS)).toBe(false)
  })
})

describe('autoRefreshPass', () => {
  const deps = (overrides: {
    vtxos: ExtendedVirtualCoin[]
    settle?: () => Promise<string>
  }) => {
    const calls = { settle: 0, onSettled: [] as string[] }
    return {
      calls,
      deps: {
        getVtxos: async () => overrides.vtxos,
        getDust: async () => DUST,
        settle: async () => {
          calls.settle++
          if (overrides.settle) return overrides.settle()
          return 'txid1'
        },
        onSettled: (txid: string) => calls.onSettled.push(txid),
      },
    }
  }

  test('idle when nothing is near expiry — settle never called', async () => {
    const { deps: d, calls } = deps({ vtxos: [vtxo({ value: 1000, batchExpiry: far() })] })
    expect(await autoRefreshPass(d)).toBe('idle')
    expect(calls.settle).toBe(0)
  })

  test('consolidates and reports the txid when a VTXO nears expiry', async () => {
    const { deps: d, calls } = deps({ vtxos: [vtxo({ value: 1000, batchExpiry: soon() })] })
    expect(await autoRefreshPass(d)).toBe('refreshed')
    expect(calls.settle).toBe(1)
    expect(calls.onSettled).toEqual(['txid1'])
  })

  test('a rejected/deferred settle is "failed" (caller backs off), onSettled untouched', async () => {
    const { deps: d, calls } = deps({
      vtxos: [vtxo({ value: 1000, batchExpiry: soon() })],
      settle: async () => {
        throw new Error('intent deferred')
      },
    })
    expect(await autoRefreshPass(d)).toBe('failed')
    expect(calls.settle).toBe(1)
    expect(calls.onSettled).toEqual([])
  })

  test('a read failure is "idle", not "failed" — nothing was attempted', async () => {
    const result = await autoRefreshPass({
      getVtxos: async () => {
        throw new Error('indexer down')
      },
      getDust: async () => DUST,
      settle: async () => 'never',
    })
    expect(result).toBe('idle')
  })
})

// The layering the whole design leans on: the SDK's partial renew must sit
// strictly inside the consolidate-all window, or it would race ahead of it.
test('SDK backstop window stays inside the auto-refresh window', () => {
  expect(VTXO_RENEW_THRESHOLD_SECONDS).toBeLessThan(AUTO_REFRESH_THRESHOLD_SECONDS)
})
