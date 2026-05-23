import type { Database } from 'bun:sqlite'

import { NwcError } from '../lib/errors'
import { transactionRowToNwc, type TransactionRow } from '../lib/transaction'
import type { Connection } from '../nostr/connections'

export interface ListTransactionsDeps {
  db: Database
  conn: Connection
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export async function handleListTransactions(
  deps: ListTransactionsDeps,
  params: Record<string, unknown>,
): Promise<unknown> {
  const from = typeof params.from === 'number' ? params.from : 0
  const until = typeof params.until === 'number' ? params.until : Math.floor(Date.now() / 1000)
  const requestedLimit = typeof params.limit === 'number' ? params.limit : DEFAULT_LIMIT
  const limit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT)
  const offset = typeof params.offset === 'number' ? Math.max(0, params.offset) : 0
  const includeUnpaid = params.unpaid === true
  const type = typeof params.type === 'string' ? params.type : undefined
  if (type !== undefined && type !== 'incoming' && type !== 'outgoing') {
    throw new NwcError('OTHER', `type must be 'incoming' or 'outgoing', got '${type}'`)
  }

  // Single SQL query — connection-scoped so a client never sees activity
  // belonging to other connections on the same wallet.
  const clauses = ['connection_id = ?', 'created_at >= ?', 'created_at <= ?']
  const args: Array<number | string> = [deps.conn.id, from, until]
  if (type !== undefined) {
    clauses.push('type = ?')
    args.push(type)
  }
  if (!includeUnpaid) {
    clauses.push("state = 'settled'")
  }

  const sql =
    `SELECT * FROM transactions WHERE ${clauses.join(' AND ')} ` +
    `ORDER BY created_at DESC LIMIT ? OFFSET ?`
  args.push(limit, offset)

  const rows = deps.db.query<TransactionRow, typeof args>(sql).all(...args)
  return { transactions: rows.map(transactionRowToNwc) }
}
