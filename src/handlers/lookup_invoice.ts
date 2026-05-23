import type { Database } from 'bun:sqlite'

import { NwcError } from '../lib/errors'
import { transactionRowToNwc, type TransactionRow } from '../lib/transaction'
import type { Connection } from '../nostr/connections'

export interface LookupInvoiceDeps {
  db: Database
  conn: Connection
}

export async function handleLookupInvoice(
  deps: LookupInvoiceDeps,
  params: Record<string, unknown>,
): Promise<unknown> {
  const paymentHash = typeof params.payment_hash === 'string' ? params.payment_hash : null
  const invoice = typeof params.invoice === 'string' ? params.invoice : null
  if (!paymentHash && !invoice) {
    throw new NwcError('OTHER', 'payment_hash or invoice is required')
  }

  // Connection-scoped lookup: a connection only sees its own transactions,
  // not anything other clients on the same wallet have done. Mirrors how
  // NIP-47 clients reason about transaction history per-connection.
  const row = paymentHash
    ? deps.db
        .query<TransactionRow, [string, number]>(
          `SELECT * FROM transactions
             WHERE payment_hash = ? AND connection_id = ?
             ORDER BY id DESC LIMIT 1`,
        )
        .get(paymentHash, deps.conn.id)
    : deps.db
        .query<TransactionRow, [string, number]>(
          `SELECT * FROM transactions
             WHERE invoice = ? AND connection_id = ?
             ORDER BY id DESC LIMIT 1`,
        )
        .get(invoice as string, deps.conn.id)

  if (row) return transactionRowToNwc(row)
  throw new NwcError('NOT_FOUND', 'no transaction found for the given parameters')
}
