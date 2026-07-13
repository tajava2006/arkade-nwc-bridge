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
  // amount_msat is the BOLT11 nominal — the number payer and payee agreed
  // on, both directions. fees_paid_msat is OUR cost of moving it (swap fee,
  // plus any drain residue on sends), paid on top of the nominal when
  // sending and out of it when receiving. Wallet movement is derived, never
  // stored: incoming credits amount − fees, outgoing debits amount + fees.
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
