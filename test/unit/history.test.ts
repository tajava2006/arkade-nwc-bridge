import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import {
  failWebLn,
  formatHistoryCursor,
  listHistoryPage,
  parseHistoryCursor,
  recordArkSend,
  recordNofferReceive,
  recordNwcLn,
  recordOffboard,
  recordOnboardPending,
  recordWebLnPending,
  settleOnboard,
  settleWebLn,
  sweepInterruptedWebSends,
  syncHistoryFromSources,
  type HistoryRow,
} from '../../src/history'
import { createOffboard, markOffboardSettled } from '../../src/offboards'
import { openTempDb, type TempDb } from '../helpers/db'

let tmp: TempDb
let db: Database

beforeEach(() => {
  tmp = openTempDb()
  db = tmp.db
})
afterEach(() => tmp.cleanup())

const allRows = (): HistoryRow[] =>
  db.query<HistoryRow, []>('SELECT * FROM history ORDER BY id').all()

const rawInsert = (createdAt: number, kind = 'ark_send'): void => {
  db.query(
    `INSERT INTO history (kind, direction, state, amount_msat, created_at)
     VALUES (?, 'out', 'settled', 1000, ?)`,
  ).run(kind, createdAt)
}

describe('listHistoryPage', () => {
  test('newest first, id-DESC tiebreak within the same second', () => {
    rawInsert(100) // id 1
    rawInsert(200) // id 2
    rawInsert(200) // id 3
    rawInsert(300) // id 4
    const page = listHistoryPage(db)
    expect(page.rows.map((r) => r.id)).toEqual([4, 3, 2, 1])
    expect(page.next).toBeNull()
  })

  test('cursor pages walk backwards without skips or duplicates across ties', () => {
    // Three rows share created_at=200 — the offset-free cursor must split
    // them across pages cleanly on the id tiebreak.
    for (const t of [100, 200, 200, 200, 300]) rawInsert(t)
    const first = listHistoryPage(db, { limit: 2 })
    expect(first.rows.map((r) => r.created_at)).toEqual([300, 200])
    expect(first.next).not.toBeNull()

    const second = listHistoryPage(db, { before: first.next!, limit: 2 })
    expect(second.rows.map((r) => r.created_at)).toEqual([200, 200])

    const third = listHistoryPage(db, { before: second.next!, limit: 2 })
    expect(third.rows.map((r) => r.created_at)).toEqual([100])
    expect(third.next).toBeNull()

    const ids = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id)
    expect(new Set(ids).size).toBe(5)
  })

  test('a row inserted mid-pagination does not shift older pages', () => {
    for (const t of [100, 200, 300]) rawInsert(t)
    const first = listHistoryPage(db, { limit: 2 })
    rawInsert(400) // arrives while the operator reads page one
    const second = listHistoryPage(db, { before: first.next!, limit: 2 })
    expect(second.rows.map((r) => r.created_at)).toEqual([100])
  })

  test('cursor string roundtrip + malformed input', () => {
    const c = { createdAt: 1721900000, id: 42 }
    expect(parseHistoryCursor(formatHistoryCursor(c))).toEqual(c)
    expect(parseHistoryCursor(null)).toBeNull()
    expect(parseHistoryCursor('')).toBeNull()
    expect(parseHistoryCursor('abc')).toBeNull()
    expect(parseHistoryCursor('12-34-56')).toBeNull()
    expect(parseHistoryCursor('-1-2')).toBeNull()
  })
})

// Minimal FK targets for transactions rows.
function insertConnection(): number {
  return db
    .query<{ id: number }, []>(
      `INSERT INTO connections (service_secret_hex, service_pubkey_hex, client_pubkey_hex, created_at)
       VALUES ('aa', 'bb', 'cc', 1000) RETURNING id`,
    )
    .get()!.id
}

function insertNwcTransaction(connId: number, eventId: string): void {
  db.query(
    `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, state, created_at)
     VALUES (?, 'outgoing', ?, 'lnbc...', 'hash', 21000, 'pending', 1000)`,
  ).run(connId, eventId)
}

describe('syncHistoryFromSources', () => {
  test('nwc_ln mirrors state/fees/settled_at from transactions', () => {
    const connId = insertConnection()
    insertNwcTransaction(connId, 'ev1')
    recordNwcLn(db, { direction: 'out', requestEventId: 'ev1', amountMsat: 21000, createdAt: 1000 })

    syncHistoryFromSources(db)
    expect(allRows()[0]!.state).toBe('pending')

    db.query(
      `UPDATE transactions SET state = 'settled', fees_paid_msat = 500, settled_at = 1100 WHERE request_event_id = 'ev1'`,
    ).run()
    syncHistoryFromSources(db)
    const row = allRows()[0]!
    expect(row.state).toBe('settled')
    expect(row.fees_msat).toBe(500)
    expect(row.settled_at).toBe(1100)

    // Idempotent: a second pass changes nothing.
    syncHistoryFromSources(db)
    expect(allRows()[0]).toEqual(row)
  })

  test('offboard mirrors state and commitment txid from offboards', () => {
    const ob = createOffboard(db, { address: 'bc1q...', amountSat: 5000, feeSat: 100, isMax: false })
    recordOffboard(db, {
      offboardId: ob.id,
      amountSat: 5000,
      feeSat: 100,
      address: 'bc1q...',
      createdAt: ob.created_at,
    })

    markOffboardSettled(db, ob.id, 'commitment-txid')
    syncHistoryFromSources(db)
    const row = allRows()[0]!
    expect(row.state).toBe('settled')
    expect(row.txid).toBe('commitment-txid')
    expect(row.fees_msat).toBe(100_000)
  })
})

describe('record helpers', () => {
  test('recordNwcLn dedupes on request_event_id', () => {
    recordNwcLn(db, { direction: 'in', requestEventId: 'ev', amountMsat: 1000, createdAt: 1 })
    recordNwcLn(db, { direction: 'in', requestEventId: 'ev', amountMsat: 1000, createdAt: 1 })
    expect(allRows().length).toBe(1)
  })

  test('recordNofferReceive is idempotent across ack-funnel retries', () => {
    recordNofferReceive(db, { ref: 'swap1', amountSats: 21, feesMsat: 0, description: 'zap' })
    recordNofferReceive(db, { ref: 'swap1', amountSats: 21, feesMsat: 0, description: 'zap' })
    const rows = allRows()
    expect(rows.length).toBe(1)
    expect(rows[0]!.state).toBe('settled')
    expect(rows[0]!.direction).toBe('in')
    expect(rows[0]!.amount_msat).toBe(21_000)
  })

  test('web_ln: pending → settled, and a retry of the same invoice resets the row', () => {
    recordWebLnPending(db, { paymentHash: 'ph', amountMsat: 77_000 })
    failWebLn(db, 'ph', 'boltz: routing failed')
    expect(allRows()[0]!.state).toBe('failed')

    // Same bolt11 retried: one invoice stays one row, back to pending.
    recordWebLnPending(db, { paymentHash: 'ph', amountMsat: 77_000 })
    const rows = allRows()
    expect(rows.length).toBe(1)
    expect(rows[0]!.state).toBe('pending')
    expect(rows[0]!.error).toBeNull()

    settleWebLn(db, 'ph', { feesMsat: 1000, txid: 'ark-txid' })
    expect(allRows()[0]!.state).toBe('settled')
    expect(allRows()[0]!.txid).toBe('ark-txid')
  })

  test('sweepInterruptedWebSends closes only pending web_ln rows', () => {
    recordWebLnPending(db, { paymentHash: 'stuck', amountMsat: 1000 })
    recordWebLnPending(db, { paymentHash: 'done', amountMsat: 1000 })
    settleWebLn(db, 'done', { feesMsat: 0 })
    recordNwcLn(db, { direction: 'out', requestEventId: 'ev', amountMsat: 1000, createdAt: 1 })

    expect(sweepInterruptedWebSends(db)).toBe(1)
    const byRef = new Map(allRows().map((r) => [r.ref, r]))
    expect(byRef.get('stuck')!.state).toBe('failed')
    expect(byRef.get('done')!.state).toBe('settled')
    expect(byRef.get('ev')!.state).toBe('pending') // nwc rows are not web sends
  })

  test('failed ark sends have no natural key and never dedupe', () => {
    recordArkSend(db, { amountSats: 10, destination: 'ark1...', error: 'boom' })
    recordArkSend(db, { amountSats: 10, destination: 'ark1...', error: 'boom' })
    recordArkSend(db, { amountSats: 10, destination: 'ark1...', txid: 'tx1' })
    expect(allRows().length).toBe(3)
  })

  test('onboard: pending on arrival, settled with the spending txid', () => {
    recordOnboardPending(db, { txid: 'fund', vout: 1, amountSats: 5000 })
    settleOnboard(db, 'fund:1', 'round-txid')
    const row = allRows()[0]!
    expect(row.state).toBe('settled')
    expect(row.txid).toBe('fund')
    expect(row.txid2).toBe('round-txid')
    expect(row.direction).toBe('in')
  })
})
