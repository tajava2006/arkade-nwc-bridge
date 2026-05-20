// NIP-47 error codes — exactly the set defined in nips/47.md §Error codes,
// plus PAYMENT_FAILED and NOT_FOUND which are method-specific.
export type NwcErrorCode =
  | 'RATE_LIMITED'
  | 'NOT_IMPLEMENTED'
  | 'INSUFFICIENT_BALANCE'
  | 'QUOTA_EXCEEDED'
  | 'RESTRICTED'
  | 'UNAUTHORIZED'
  | 'INTERNAL'
  | 'UNSUPPORTED_ENCRYPTION'
  | 'PAYMENT_FAILED'
  | 'NOT_FOUND'
  | 'OTHER'

export class NwcError extends Error {
  constructor(
    public readonly code: NwcErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'NwcError'
  }
}
