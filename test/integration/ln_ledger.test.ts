import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SqliteAtomicSwapRepository, SwapDirection, type AtomicSwapState } from '../../src/atomic'
import { reconcileAtomicSendRows, watchUnresolvedSolverSends } from '../../src/ln_ledger'
import { createConnection } from '../../src/nostr/connections'
import { openTempDb, type TempDb } from '../helpers/db'

// M1/R2 — the crash-window reconcile for sub-dust sends (moved off boltz.ts).

describe('reconcileAtomicSendRows', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => temp.cleanup())

  const pendingRow = () => {
    const conn = createConnection(temp.db, { label: null, relays: ['wss://r'] }).connection
    temp.db
      .query(
        `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, state, created_at)
         VALUES (?, 'outgoing', 'evt-1', 'lnbcfake', ?, 21000, 'pending', ?)`,
      )
      .run(conn.id, 'ff'.repeat(32), Math.floor(Date.now() / 1000))
    return conn.id
  }
  const atomicSend = (state: AtomicSwapState) =>
    new SqliteAtomicSwapRepository(temp.db).create({
      id: 'atomic-send-1',
      direction: SwapDirection.Send,
      paymentHash: 'ff'.repeat(32),
      state,
      amount: 21,
      refundLocktime: Math.floor(Date.now() / 1000) + 3600,
      preimage: 'ee'.repeat(32),
    })
  const row = () => temp.db.query<{ state: string; preimage: string | null }, []>('SELECT state, preimage FROM transactions').get()!
  const spent = (id: number) => temp.db.query<{ s: number }, [number]>('SELECT spent_msat AS s FROM connections WHERE id = ?').get(id)!.s

  test("claimed: settled with the preimage and booked into the 'never' counter, once", () => {
    const id = pendingRow()
    atomicSend('claimed')
    reconcileAtomicSendRows(temp.db)
    reconcileAtomicSendRows(temp.db)
    expect(row()).toEqual({ state: 'settled', preimage: 'ee'.repeat(32) })
    expect(spent(id)).toBe(21000)
  })

  test('refunded: failed (the payment never landed)', () => {
    pendingRow()
    atomicSend('refunded')
    reconcileAtomicSendRows(temp.db)
    expect(row().state).toBe('failed')
  })

  test('in flight: left pending', () => {
    pendingRow()
    atomicSend('ln_inflight')
    reconcileAtomicSendRows(temp.db)
    expect(row().state).toBe('pending')
  })

  test('no atomic row (a solver send): untouched', () => {
    pendingRow()
    reconcileAtomicSendRows(temp.db)
    expect(row().state).toBe('pending')
  })
})

describe('watchUnresolvedSolverSends (F31)', () => {
  const send = (id: string, outcome: string, createdAt: number) =>
    ({
      id,
      outcome,
      createdAt,
      route: { give: { corridor: 'arkade' }, take: { corridor: 'lightning' } },
      take: { amount: 5000n },
      give: { amount: 5005n },
      lock: { hash: 'ab'.repeat(32) },
    }) as never

  test('one DM per send open past the threshold; settled, fresh or receive swaps stay quiet', async () => {
    const dms: string[] = []
    const swaps = [
      send('rfq:old-funded', 'funded', 1000),
      send('rfq:fresh', 'funded', 9000),
      send('rfq:old-paid', 'paid', 1000),
      { ...(send('rfq:recv', 'funded', 1000) as object), route: { give: { corridor: 'lightning' }, take: { corridor: 'arkade' } } } as never,
    ]
    const w = watchUnresolvedSolverSends({
      client: { swaps: async () => swaps },
      notify: ((_k: string, build: () => string) => dms.push(build())) as never,
      thresholdSecs: 1800,
      intervalMs: 1e9,
      now: () => 10_000,
    })
    try {
      expect(await w.pass()).toEqual(['rfq:old-funded'])
      expect(dms).toHaveLength(1)
      expect(dms[0]).toContain('refund-now')
      expect(dms[0]).toContain('5000 sats')
      expect(await w.pass()).toEqual([]) // once per swap
    } finally {
      w.stop()
    }
  })

  test('a failing read never throws out of the pass', async () => {
    const w = watchUnresolvedSolverSends({ client: { swaps: async () => { throw new Error('store') } }, intervalMs: 1e9 })
    try {
      expect(await w.pass()).toEqual([])
    } finally {
      w.stop()
    }
  })
})
