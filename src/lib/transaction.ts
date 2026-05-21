// Row shapes for the invoices / payments tables (snake_case as returned by
// sqlite) and the conversion to the NIP-47 transaction object shape (camel +
// underscore mix per the spec).
//
// undefined-valued fields drop out of JSON.stringify, so a row without a
// preimage just doesn't carry a preimage field in the response — matches the
// "optional if unpaid" semantics NIP-47 specifies for lookup_invoice /
// list_transactions.

export interface InvoiceRow {
  id: number
  connection_id: number
  request_event_id: string
  invoice: string
  payment_hash: string
  amount_msat: number
  description: string | null
  swap_id: string | null
  state: string
  preimage: string | null
  claimed_txid: string | null
  created_at: number
  expires_at: number | null
  settled_at: number | null
}

export interface PaymentRow {
  id: number
  connection_id: number
  request_event_id: string
  invoice: string
  payment_hash: string
  amount_msat: number
  fees_paid_msat: number | null
  swap_id: string | null
  state: string
  preimage: string | null
  error: string | null
  created_at: number
  settled_at: number | null
}

export function invoiceRowToTransaction(row: InvoiceRow): Record<string, unknown> {
  return {
    type: 'incoming',
    state: row.state,
    invoice: row.invoice,
    description: row.description ?? undefined,
    preimage: row.preimage ?? undefined,
    payment_hash: row.payment_hash,
    amount: row.amount_msat,
    created_at: row.created_at,
    expires_at: row.expires_at ?? undefined,
    settled_at: row.settled_at ?? undefined,
  }
}

export function paymentRowToTransaction(row: PaymentRow): Record<string, unknown> {
  return {
    type: 'outgoing',
    state: row.state,
    invoice: row.invoice,
    preimage: row.preimage ?? undefined,
    payment_hash: row.payment_hash,
    amount: row.amount_msat,
    fees_paid: row.fees_paid_msat ?? undefined,
    created_at: row.created_at,
    settled_at: row.settled_at ?? undefined,
  }
}
