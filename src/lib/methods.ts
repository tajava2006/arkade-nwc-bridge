// Single source of truth for the NWC methods this bridge implements.
// Used both in the kind 13194 info event we publish per connection and in
// dispatch's exhaustiveness checks. Keeping them in lockstep matters —
// advertising a method we don't dispatch (or vice versa) confuses clients.
//
// make_invoice is intentionally absent: receiving is funneled through the CLINK
// noffer (a public, static receive code), not per-connection NWC invoices. One
// receive path = far less surface (incl. sub-dust + ack handling). A make_invoice
// request falls through to NOT_IMPLEMENTED.
export const SUPPORTED_METHODS = [
  'get_info',
  'get_balance',
  'pay_invoice',
  'lookup_invoice',
  'list_transactions',
] as const

export type SupportedMethod = (typeof SUPPORTED_METHODS)[number]
