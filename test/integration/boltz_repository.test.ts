import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BoltzReverseSwap, BoltzSubmarineSwap, BoltzSwap } from '@arkade-os/boltz-swap'
import { SqliteSwapRepository } from '../../src/boltz_repository'
import { openTempDb, type TempDb } from '../helpers/db'

// SwapRepository is the upstream interface; if a method gets added/removed
// in @arkade-os/boltz-swap, the `implements` clause in
// src/boltz_repository.ts breaks at typecheck. These runtime tests just
// confirm we still satisfy the *behavior* contract on the methods we use.

function reverse(id: string, status: BoltzReverseSwap['status'] = 'swap.created'): BoltzReverseSwap {
  return {
    id,
    type: 'reverse',
    createdAt: Math.floor(Date.now() / 1000),
    preimage: 'aa'.repeat(32),
    status,
    request: {} as BoltzReverseSwap['request'],
    response: {} as BoltzReverseSwap['response'],
  }
}

function submarine(
  id: string,
  status: BoltzSubmarineSwap['status'] = 'swap.created',
): BoltzSubmarineSwap {
  return {
    id,
    type: 'submarine',
    createdAt: Math.floor(Date.now() / 1000),
    status,
    request: {} as BoltzSubmarineSwap['request'],
    response: {} as BoltzSubmarineSwap['response'],
    preimage: undefined,
  } as BoltzSubmarineSwap
}

describe('SqliteSwapRepository', () => {
  let temp: TempDb
  let repo: SqliteSwapRepository
  beforeEach(() => {
    temp = openTempDb()
    repo = new SqliteSwapRepository(temp.db)
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('saveSwap + getAllSwaps round-trips a reverse swap', async () => {
    const swap = reverse('rev-1')
    await repo.saveSwap(swap)
    const all = await repo.getAllSwaps()
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe('rev-1')
    expect(all[0]?.type).toBe('reverse')
  })

  test('saveSwap is upsert (same id replaces)', async () => {
    await repo.saveSwap(reverse('rev-2', 'swap.created'))
    await repo.saveSwap(reverse('rev-2', 'transaction.confirmed'))
    const all = await repo.getAllSwaps()
    expect(all).toHaveLength(1)
    expect(all[0]?.status).toBe('transaction.confirmed')
  })

  test('deleteSwap removes the row', async () => {
    await repo.saveSwap(reverse('rev-3'))
    await repo.deleteSwap('rev-3')
    expect(await repo.getAllSwaps()).toHaveLength(0)
  })

  test('filters by id, status, type — single or array', async () => {
    await repo.saveSwap(reverse('a', 'swap.created'))
    await repo.saveSwap(reverse('b', 'invoice.set'))
    await repo.saveSwap(submarine('c', 'swap.created'))

    expect(await repo.getAllSwaps({ id: 'a' })).toHaveLength(1)
    expect(await repo.getAllSwaps({ id: ['a', 'b'] })).toHaveLength(2)
    expect(await repo.getAllSwaps({ status: 'swap.created' })).toHaveLength(2)
    expect(await repo.getAllSwaps({ type: 'reverse' })).toHaveLength(2)
    expect(await repo.getAllSwaps({ type: 'submarine' })).toHaveLength(1)
  })

  test('empty array filter returns nothing without running a query', async () => {
    await repo.saveSwap(reverse('a'))
    expect(await repo.getAllSwaps({ id: [] })).toEqual([])
    expect(await repo.getAllSwaps({ status: [] })).toEqual([])
    expect(await repo.getAllSwaps({ type: [] })).toEqual([])
  })

  test('orderDirection desc reverses createdAt order', async () => {
    const now = Math.floor(Date.now() / 1000)
    const earlier: BoltzSwap = { ...reverse('older'), createdAt: now - 100 }
    const later: BoltzSwap = { ...reverse('newer'), createdAt: now }
    await repo.saveSwap(earlier)
    await repo.saveSwap(later)
    const asc = await repo.getAllSwaps({ orderDirection: 'asc' })
    const desc = await repo.getAllSwaps({ orderDirection: 'desc' })
    expect(asc.map((s) => s.id)).toEqual(['older', 'newer'])
    expect(desc.map((s) => s.id)).toEqual(['newer', 'older'])
  })

  test('clear wipes everything', async () => {
    await repo.saveSwap(reverse('a'))
    await repo.saveSwap(submarine('b'))
    await repo.clear()
    expect(await repo.getAllSwaps()).toHaveLength(0)
  })
})
