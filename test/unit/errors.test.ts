import { describe, expect, test } from 'bun:test'
import { NwcError, type NwcErrorCode } from '../../src/lib/errors'

describe('NwcError', () => {
  test('is an Error subclass with code + message', () => {
    const err = new NwcError('PAYMENT_FAILED', 'route closed')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(NwcError)
    expect(err.code).toBe('PAYMENT_FAILED')
    expect(err.message).toBe('route closed')
    expect(err.name).toBe('NwcError')
  })

  test('all NIP-47 codes are constructible (compile-time exhaustiveness)', () => {
    // If a code is removed from the union the assignment below stops
    // compiling — catches accidental deletions in upgrade refactors.
    const codes: NwcErrorCode[] = [
      'RATE_LIMITED',
      'NOT_IMPLEMENTED',
      'INSUFFICIENT_BALANCE',
      'QUOTA_EXCEEDED',
      'RESTRICTED',
      'UNAUTHORIZED',
      'INTERNAL',
      'UNSUPPORTED_ENCRYPTION',
      'PAYMENT_FAILED',
      'NOT_FOUND',
      'OTHER',
    ]
    for (const code of codes) {
      const err = new NwcError(code, 'x')
      expect(err.code).toBe(code)
    }
  })
})
