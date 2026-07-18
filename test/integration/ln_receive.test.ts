import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { issueInvoice } from '../../src/ln_receive'
import { INVOICE_2000_SAT, fakeInvoiceResponse, makeSwapsStub, makeWalletStub } from '../helpers/mocks'

// The sub-dust receive branch now routes through the ATOMIC path
// (issueAtomicReceive → boltz /v2/subdust/atomic/receive/*), which needs the
// SDK's ark providers + a live boltz — too coupled to mock here. It's validated
// end-to-end by the #14 receive drill (atomic_receive_e2e), which replaced the
// removed non-atomic plain-path unit tests (issueInvoice sub-dust +
// reconcileSubdustReceives). This file keeps the ≥dust reverse-swap branch,
// which the atomic change doesn't touch.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// The ≥dust reverse-swap branch never touches the atomic sub-dust deps; a
// throwaway db and empty ASP url satisfy the type without being read.
const noAtomic = { arkServerUrl: '', db: new Database(':memory:') }

describe('issueInvoice — ≥dust reverse swap', () => {
  test('≥dust creates a reverse swap and never touches the sub-dust path', async () => {
    globalThis.fetch = (async () => {
      throw new Error('sub-dust path must not be used at/above dust')
    }) as unknown as typeof fetch
    const swaps = makeSwapsStub({
      createLightningInvoice: async (args) => {
        expect(args.amount).toBe(330)
        // Real decodable bolt11: issueInvoice decodes it for absoluteExpiry.
        return fakeInvoiceResponse({ amount: 320, invoice: INVOICE_2000_SAT, paymentHash: 'aa'.repeat(32) })
      },
    })

    const issued = await issueInvoice(
      { swaps, wallet: makeWalletStub(), boltzApiUrl: 'http://boltz', ...noAtomic },
      { amountSats: 330 },
    )

    expect(issued.kind).toBe('swap')
    if (issued.kind !== 'swap') throw new Error('unreachable')
    expect(issued.swapId).toBe('swap-id-fake')
    expect(issued.invoice).toBe(INVOICE_2000_SAT)
    expect(issued.paymentHash).toBe('aa'.repeat(32))
    expect(issued.receivedSats).toBe(320) // post-fee on-Ark amount
  })
})
