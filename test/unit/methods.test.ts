import { describe, expect, test } from 'bun:test'
import { SUPPORTED_METHODS } from '../../src/lib/methods'

describe('SUPPORTED_METHODS', () => {
  test('is exactly the six methods the bridge advertises and dispatches', () => {
    // Locked-list test: drift between this and either the kind-13194 info
    // event or the dispatch switch breaks the client contract. Treat any
    // edit as deliberate — update both sides together.
    expect([...SUPPORTED_METHODS]).toEqual([
      'get_info',
      'get_balance',
      'make_invoice',
      'pay_invoice',
      'lookup_invoice',
      'list_transactions',
    ])
  })
})
