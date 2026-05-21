import type { Database } from 'bun:sqlite'

import { NwcError } from '../lib/errors'
import {
  invoiceRowToTransaction,
  paymentRowToTransaction,
  type InvoiceRow,
  type PaymentRow,
} from '../lib/transaction'

export interface ListTransactionsDeps {
  db: Database
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

  const merged: Array<Record<string, unknown>> = []

  if (type !== 'outgoing') {
    let sql = 'SELECT * FROM invoices WHERE created_at >= ? AND created_at <= ?'
    if (!includeUnpaid) sql += " AND state = 'settled'"
    sql += ' ORDER BY created_at DESC'
    const rows = deps.db.query<InvoiceRow, [number, number]>(sql).all(from, until)
    for (const r of rows) merged.push(invoiceRowToTransaction(r))
  }
  if (type !== 'incoming') {
    let sql = 'SELECT * FROM payments WHERE created_at >= ? AND created_at <= ?'
    if (!includeUnpaid) sql += " AND state = 'settled'"
    sql += ' ORDER BY created_at DESC'
    const rows = deps.db.query<PaymentRow, [number, number]>(sql).all(from, until)
    for (const r of rows) merged.push(paymentRowToTransaction(r))
  }

  // In-memory merge sort: each side is already sorted desc, but pulling
  // both then sorting is simpler and fine at the volumes we expect. If row
  // counts grow we can swap in a UNION ALL query with a window-function
  // ORDER BY without touching the response shape.
  merged.sort((a, b) => Number(b.created_at) - Number(a.created_at))

  return { transactions: merged.slice(offset, offset + limit) }
}
