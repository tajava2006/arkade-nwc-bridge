import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/db'
import { openSwapRepository, SWAP_TABLE_PREFIX } from '../../src/swap_store'

// The swap package's SQLite backend over our bun:sqlite executor, in the
// bridge's own database. What matters: records round-trip whole, survive a
// restart (claim secrets live here), and the backend's own DDL and
// transactions run through the executor.

const record = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) =>
  ({ id, family: 'rfq', updatedAt, createdAt: updatedAt, secret: 'aa'.repeat(32), nested: { hashlock: { preimage: 'bb'.repeat(32) } }, ...extra }) as never
const rfq = (rfqId: string, state: string, updatedAt: number) => ({ rfqId, state, updatedAt, profile: { k: 'v' } }) as never

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'bridge-swapstore-')), 'bridge.sqlite')

describe('swap repository on the bridge sqlite', () => {
  test('swap records round-trip whole, including nested secrets', async () => {
    const repo = openSwapRepository(openDatabase(freshPath()))
    await repo.saveSwapRecord(record('q1', 100))
    expect(await repo.getSwapRecord('q1')).toEqual(record('q1', 100))
    expect(await repo.getSwapRecord('nope')).toBeUndefined()
  })

  test('survives a restart — a live swap must still be claimable after a reboot', async () => {
    const path = freshPath()
    const a = openSwapRepository(openDatabase(path))
    await a.saveSwapRecord(record('q1', 100))
    await a.saveRfqSwap(rfq('r1', 'funded', 100))
    await a.markTxidsScanned(['t1', 't2'])
    const b = openSwapRepository(openDatabase(path))
    expect(await b.getSwapRecord('q1')).toEqual(record('q1', 100))
    expect(await b.getRfqSwap('r1')).toEqual(rfq('r1', 'funded', 100))
    expect([...(await b.getScannedTxids())].sort()).toEqual(['t1', 't2'])
  })

  test('save replaces, remove deletes, pages list everything', async () => {
    const repo = openSwapRepository(openDatabase(freshPath()))
    await repo.saveSwapRecord(record('q1', 100))
    await repo.saveSwapRecord(record('q2', 200))
    await repo.saveSwapRecord(record('q1', 300, { note: 'replaced' }))
    expect((await repo.getSwapRecord('q1')) as unknown).toMatchObject({ note: 'replaced' })
    const page = await repo.getSwapRecordsPage({ limit: 10 } as never)
    expect(page.items.map((r) => (r as { id: string }).id).sort()).toEqual(['q1', 'q2'])
    await repo.removeSwapRecord('q2')
    expect(await repo.getSwapRecord('q2')).toBeUndefined()
  })

  test('markets cache keyed by network + registry', async () => {
    const repo = openSwapRepository(openDatabase(freshPath()))
    const entry = { markets: [], fetchedAt: 123 } as never
    await repo.saveCachedMarkets('regtest', 'local', entry)
    expect(await repo.getCachedMarkets('regtest', 'local')).toEqual(entry)
    expect(await repo.getCachedMarkets('bitcoin', 'local')).toBeUndefined()
  })

  test('its tables carry our prefix and stay out of the bridge schema', async () => {
    const db = openDatabase(freshPath())
    const repo = openSwapRepository(db)
    await repo.saveSwapRecord(record('q1', 100))
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?1")
      .all(`${SWAP_TABLE_PREFIX}%` as never)
      .map((t) => t.name)
    expect(tables.length).toBeGreaterThan(0)
    expect(tables.every((t) => t.startsWith(SWAP_TABLE_PREFIX))).toBe(true)
  })
})
