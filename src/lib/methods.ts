// Single source of truth for the NWC methods this bridge implements.
// Used both in the kind 13194 info event we publish per connection and in
// dispatch's exhaustiveness checks. Keeping them in lockstep matters —
// advertising a method we don't dispatch (or vice versa) confuses clients.
//
// make_invoice shares the CLINK noffer's LN-receive core (src/ln_receive.ts),
// so both entry points get identical sub-dust handling; only the bookkeeping
// differs (NWC: connection-scoped transactions row; CLINK: ack receipts).
export const SUPPORTED_METHODS = [
  'get_info',
  'get_balance',
  'make_invoice',
  'pay_invoice',
  'lookup_invoice',
  'list_transactions',
] as const

export type SupportedMethod = (typeof SUPPORTED_METHODS)[number]
