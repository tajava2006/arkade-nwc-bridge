import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openDatabase } from '../../src/db'
import { createConnection } from '../../src/nostr/connections'
import { openTempDb, type TempDb } from '../helpers/db'

describe('database migrations', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('fresh boot creates all expected tables', () => {
    const tables = temp.db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name)
    expect(tables).toEqual([
      'accounts',
      'boltz_swaps',
      'clink_offer',
      'clink_offer_receipts',
      'clink_subdust_receipts',
      'connections',
      'offboards',
      'processed_events',
      'schema_migrations',
      'transactions',
    ])
  })

  test('schema_migrations records every applied version exactly once', () => {
    const rows = temp.db
      .query<{ version: number; description: string }, []>(
        'SELECT version, description FROM schema_migrations ORDER BY version',
      )
      .all()
    // Bumps here are intentional. If you added a migration without
    // realizing, this test surfaces it.
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('re-opening the same db is idempotent (no double-apply)', () => {
    const path = temp.path
    temp.db.close()

    const db2 = openDatabase(path)
    try {
      const count = db2
        .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM schema_migrations')
        .get()
      expect(count?.c).toBe(9)
    } finally {
      db2.close()
    }
  })

  test('WAL journal mode is enabled', () => {
    const mode = temp.db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
    expect(mode?.journal_mode).toBe('wal')
  })

  test('foreign keys are enforced', () => {
    const fk = temp.db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()
    expect(fk?.foreign_keys).toBe(1)

    // A transactions row with no matching connection_id must be rejected.
    expect(() =>
      temp.db
        .query(
          `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, state, created_at)
           VALUES (?, 'incoming', 'e', 'i', 'p', 1000, 'pending', 1)`,
        )
        .run(99999),
    ).toThrow()
  })

  test('transactions.request_event_id is unique (replay protection)', () => {
    const conn = createConnection(temp.db, { label: null, relays: ['wss://r'] })
    const insert = () =>
      temp.db
        .query(
          `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, state, created_at)
           VALUES (?, 'incoming', 'evt-dupe', 'i', 'p', 1000, 'pending', 1)`,
        )
        .run(conn.connection.id)
    insert()
    expect(insert).toThrow()
  })
})
