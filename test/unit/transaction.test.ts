import { describe, expect, test } from 'bun:test'
import { transactionRowToNwc, type TransactionRow } from '../../src/lib/transaction'

function row(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: 1,
    connection_id: 1,
    type: 'incoming',
    request_event_id: 'evt',
    invoice: 'lnbc',
    payment_hash: 'ph',
    amount_msat: 1_000,
    fees_paid_msat: null,
    description: null,
    swap_id: null,
    state: 'pending',
    preimage: null,
    error: null,
    created_at: 1700000000,
    expires_at: null,
    settled_at: null,
    ...overrides,
  }
}

describe('transactionRowToNwc', () => {
  test('drops null optional fields so they disappear from JSON', () => {
    // NIP-47 says optional-when-unpaid fields should be absent, not null.
    // JSON.stringify drops undefined; null gets serialized. The mapper has
    // to convert.
    const mapped = transactionRowToNwc(row()) as Record<string, unknown>
    const serialized = JSON.parse(JSON.stringify(mapped))
    expect(serialized).not.toHaveProperty('description')
    expect(serialized).not.toHaveProperty('preimage')
    expect(serialized).not.toHaveProperty('fees_paid')
    expect(serialized).not.toHaveProperty('expires_at')
    expect(serialized).not.toHaveProperty('settled_at')
  })

  test('preserves all populated fields with NIP-47 names', () => {
    const mapped = transactionRowToNwc(
      row({
        type: 'outgoing',
        state: 'settled',
        invoice: 'lnbc-paid',
        description: 'pizza',
        preimage: 'pi'.repeat(16),
        payment_hash: 'ph-1',
        amount_msat: 5_000,
        fees_paid_msat: 500,
        created_at: 1700001000,
        expires_at: 1700002000,
        settled_at: 1700001500,
      }),
    )
    expect(mapped).toEqual({
      type: 'outgoing',
      state: 'settled',
      invoice: 'lnbc-paid',
      description: 'pizza',
      preimage: 'pi'.repeat(16),
      payment_hash: 'ph-1',
      amount: 5_000,
      fees_paid: 500,
      created_at: 1700001000,
      expires_at: 1700002000,
      settled_at: 1700001500,
    })
  })

  test('renames amount_msat to amount and fees_paid_msat to fees_paid', () => {
    // NIP-47 transaction object uses unsuffixed names.
    const mapped = transactionRowToNwc(row({ amount_msat: 7_000, fees_paid_msat: 100 })) as Record<
      string,
      unknown
    >
    expect(mapped).not.toHaveProperty('amount_msat')
    expect(mapped).not.toHaveProperty('fees_paid_msat')
    expect(mapped.amount).toBe(7_000)
    expect(mapped.fees_paid).toBe(100)
  })
})
