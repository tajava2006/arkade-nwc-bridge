// Single source of truth for the NWC methods this bridge implements.
// Used both in the kind 13194 info event we publish per connection and in
// dispatch's exhaustiveness checks. Keeping them in lockstep matters —
// advertising a method we don't dispatch (or vice versa) confuses clients.
export const SUPPORTED_METHODS = [
  'get_info',
  'get_balance',
  'make_invoice',
  'pay_invoice',
  'lookup_invoice',
  'list_transactions',
] as const

export type SupportedMethod = (typeof SUPPORTED_METHODS)[number]
