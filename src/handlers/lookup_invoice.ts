import type { Database } from 'bun:sqlite'

import { NwcError } from '../lib/errors'
import {
  invoiceRowToTransaction,
  paymentRowToTransaction,
  type InvoiceRow,
  type PaymentRow,
} from '../lib/transaction'

export interface LookupInvoiceDeps {
  db: Database
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

  // Try the incoming (invoices) table first, then outgoing (payments).
  // Payment hashes are globally unique per LN invoice, so either side gives
  // at most one row — there's no ambiguity in which table to prefer.
  const incoming = paymentHash
    ? deps.db
        .query<InvoiceRow, [string]>(
          'SELECT * FROM invoices WHERE payment_hash = ? ORDER BY id DESC LIMIT 1',
        )
        .get(paymentHash)
    : deps.db
        .query<InvoiceRow, [string]>(
          'SELECT * FROM invoices WHERE invoice = ? ORDER BY id DESC LIMIT 1',
        )
        .get(invoice as string)
  if (incoming) return invoiceRowToTransaction(incoming)

  const outgoing = paymentHash
    ? deps.db
        .query<PaymentRow, [string]>(
          'SELECT * FROM payments WHERE payment_hash = ? ORDER BY id DESC LIMIT 1',
        )
        .get(paymentHash)
    : deps.db
        .query<PaymentRow, [string]>(
          'SELECT * FROM payments WHERE invoice = ? ORDER BY id DESC LIMIT 1',
        )
        .get(invoice as string)
  if (outgoing) return paymentRowToTransaction(outgoing)

  throw new NwcError('NOT_FOUND', 'no transaction found for the given parameters')
}
