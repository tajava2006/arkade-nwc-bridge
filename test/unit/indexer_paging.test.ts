import { describe, expect, test } from 'bun:test'
import type { VirtualCoin } from '@arkade-os/sdk'
import { fetchWholeVtxoSet, type VtxoPageFetcher } from '../../src/indexer'

type Opts = Parameters<VtxoPageFetcher>[0]

const SCRIPTS = { scripts: ['5120' + 'ab'.repeat(32)] } as NonNullable<Opts>

function coin(n: number): VirtualCoin {
  return { txid: String(n).padStart(64, '0'), vout: 0, value: 1 } as unknown as VirtualCoin
}

/** Records every request, and answers from a fixed row set the way arkd would. */
function server(rows: VirtualCoin[], opts: { cap?: number } = {}) {
  const calls: Opts[] = []
  const cap = opts.cap
  const fetchPage: VtxoPageFetcher = async (o) => {
    calls.push(o)
    // No page params => arkd's uncapped path: everything, no page response.
    if (o?.pageIndex === undefined && o?.pageSize === undefined) {
      return cap === undefined
        ? { vtxos: rows, page: undefined }
        : // a server that paginates even an unpaged request
          {
            vtxos: rows.slice(0, cap),
            page: { current: 1, next: 2, total: Math.ceil(rows.length / cap) },
          }
    }
    // Paged: arkd clamps to its own max and normalises PageNum <= 0 to 1.
    const size = Math.min(o.pageSize ?? 100, cap ?? 100)
    const num = Math.max(1, o.pageIndex ?? 1)
    const total = Math.ceil(rows.length / size)
    return {
      vtxos: rows.slice((num - 1) * size, num * size),
      page: { current: num, next: Math.min(num + 1, total), total },
    }
  }
  return { fetchPage, calls }
}

describe('fetchWholeVtxoSet', () => {
  test('asks without pagination so arkd takes its uncapped path', async () => {
    const rows = Array.from({ length: 228 }, (_, i) => coin(i))
    const { fetchPage, calls } = server(rows)

    // The SDK always asks with its own pageIndex/pageSize; both must be dropped.
    await fetchWholeVtxoSet(fetchPage, { ...SCRIPTS, pageIndex: 0, pageSize: 500 })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(SCRIPTS)
  })

  test('returns the whole set and never reports a page', async () => {
    const rows = Array.from({ length: 228 }, (_, i) => coin(i))
    const { fetchPage } = server(rows)

    const res = await fetchWholeVtxoSet(fetchPage, { ...SCRIPTS, pageIndex: 0, pageSize: 500 })

    // page: undefined is what ends the SDK's loop (`hasMore = page ? … : false`)
    // after this one complete answer.
    expect(res.page).toBeUndefined()
    expect(res.vtxos).toHaveLength(228)
  })

  test('the 228-row mainnet case: the oldest rows survive', async () => {
    // arkd sorts newest-first, so the regression dropped the TAIL. Those are
    // the rows nearest expiry — the three sub-dust vtxos of 2026-09-21.
    const rows = Array.from({ length: 228 }, (_, i) => coin(i))
    const { fetchPage } = server(rows)

    const res = await fetchWholeVtxoSet(fetchPage, { ...SCRIPTS, pageIndex: 0, pageSize: 500 })

    const got = new Set(res.vtxos.map((v) => v.txid))
    for (const oldest of rows.slice(100)) expect(got.has(oldest.txid)).toBe(true)
  })

  test('falls back to walking every page when even an unpaged query paginates', async () => {
    const rows = Array.from({ length: 228 }, (_, i) => coin(i))
    const { fetchPage, calls } = server(rows, { cap: 100 })

    const res = await fetchWholeVtxoSet(fetchPage, { ...SCRIPTS, pageIndex: 0, pageSize: 500 })

    expect(res.vtxos).toHaveLength(228)
    expect(res.page).toBeUndefined()
    // probe + pages 1..3, and the walk must START AT 1: arkd normalises
    // PageNum <= 0 to 1, so a 0-based walk never reaches page 2.
    expect(calls.map((c) => c?.pageIndex)).toEqual([undefined, 1, 2, 3])
  })

  test('the fallback unions by outpoint, so overlapping walks do not duplicate', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => coin(i))
    const { fetchPage } = server(rows, { cap: 100 })

    const res = await fetchWholeVtxoSet(fetchPage, { ...SCRIPTS, pageIndex: 0, pageSize: 500 })

    // page 1 is served twice (probe + walk) — dedupe by outpoint, not concat.
    expect(res.vtxos).toHaveLength(150)
    expect(new Set(res.vtxos.map((v) => v.txid)).size).toBe(150)
  })

  test('refuses to answer rather than report a set that may be incomplete', async () => {
    // A server whose `total` never comes true — the shape that would silently
    // truncate. It must raise, not return a short set.
    const fetchPage: VtxoPageFetcher = async (o) =>
      o?.pageIndex === undefined
        ? { vtxos: [coin(0)], page: { current: 1, next: 2, total: 9_999 } }
        : { vtxos: [coin(o.pageIndex)], page: { current: 1, next: 2, total: 9_999 } }

    expect(fetchWholeVtxoSet(fetchPage, SCRIPTS)).rejects.toThrow(/did not terminate/)
  })

  test('outpoint lookups pass straight through', async () => {
    const { fetchPage, calls } = server([coin(1)])
    const byOutpoint = { outpoints: [{ txid: 'aa'.repeat(32), vout: 0 }] } as NonNullable<Opts>

    const res = await fetchWholeVtxoSet(fetchPage, byOutpoint)

    expect(calls[0]).toEqual(byOutpoint)
    expect(res.vtxos).toHaveLength(1)
  })
})
