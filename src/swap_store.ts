import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { SQLExecutor } from '@arkade-os/sdk/repositories/sqlite'
import { SQLiteAssetSwapRepository } from '@arkade-os/swap/repositories/sqlite'

// The swap client's durable store (accept records, claim secrets, restore
// cursor, markets cache) in the bridge's own sqlite file, through the swap
// package's SQLite backend. That backend owns its tables (CREATE IF NOT EXISTS
// on first use, whole records as JSON), so they sit outside the bridge's
// append-only migrations, behind a prefix. One file keeps one backup.
//
// Losing this store loses live swaps' claim secrets, which is why the client
// refuses to run without one and why it is never in memory here.

export const SWAP_TABLE_PREFIX = 'swapclient_'

/**
 * The SDK's SQLExecutor over bun:sqlite. A parameterless statement may be a
 * multi-statement DDL batch, which only `exec` runs whole (a prepared
 * statement stops after the first).
 */
export const bunSqlExecutor = (db: Database): SQLExecutor => ({
  async run(sql, params = []) {
    if (params.length === 0) db.exec(sql)
    else db.query(sql).run(...(params as SQLQueryBindings[]))
  },
  async get<T>(sql: string, params: unknown[] = []) {
    return (db.query(sql).get(...(params as SQLQueryBindings[])) ?? undefined) as T | undefined
  },
  async all<T>(sql: string, params: unknown[] = []) {
    return db.query(sql).all(...(params as SQLQueryBindings[])) as T[]
  },
})

/** One repository per database: the backend keys its write chain by executor instance. */
export const openSwapRepository = (db: Database): SQLiteAssetSwapRepository =>
  new SQLiteAssetSwapRepository(bunSqlExecutor(db), { prefix: SWAP_TABLE_PREFIX })
