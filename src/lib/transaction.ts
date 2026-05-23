// Row shape for the unified transactions table and its conversion to the
// NIP-47 transaction object the lookup_invoice / list_transactions handlers
// return.
//
// undefined-valued fields drop out of JSON.stringify, so a row without a
// preimage just doesn't carry a preimage field in the response — matches
// the "optional if unpaid" semantics NIP-47 specifies.

export interface TransactionRow {
  id: number
  connection_id: number
  type: 'incoming' | 'outgoing'
  request_event_id: string
  invoice: string
  payment_hash: string
  // amount_msat semantics: the on-Ark wallet movement. For incoming this
  // is what was credited (invoice nominal minus the swap provider's fee);
  // for outgoing this is what left the wallet (invoice nominal plus the
  // fee). fees_paid_msat carries the gap explicitly.
  amount_msat: number
  fees_paid_msat: number | null
  description: string | null
  swap_id: string | null
  state: string
  preimage: string | null
  error: string | null
  created_at: number
  expires_at: number | null
  settled_at: number | null
}

export function transactionRowToNwc(row: TransactionRow): Record<string, unknown> {
  return {
    type: row.type,
    state: row.state,
    invoice: row.invoice,
    description: row.description ?? undefined,
    preimage: row.preimage ?? undefined,
    payment_hash: row.payment_hash,
    amount: row.amount_msat,
    fees_paid: row.fees_paid_msat ?? undefined,
    created_at: row.created_at,
    expires_at: row.expires_at ?? undefined,
    settled_at: row.settled_at ?? undefined,
  }
}
