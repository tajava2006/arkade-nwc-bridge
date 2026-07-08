import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { decodeInvoice } from '@arkade-os/boltz-swap'

import { issueInvoice, reconcileSubdustReceives } from '../../src/ln_receive'
import { createConnection } from '../../src/nostr/connections'
import { openTempDb, type TempDb } from '../helpers/db'
import {
  INVOICE_2000_SAT,
  fakeInvoiceResponse,
  makeSwapsStub,
  makeWalletStub,
} from '../helpers/mocks'

// The sub-dust branch and the reconciler talk to boltz over plain fetch —
// intercept globally per test and restore so other suites see the real one.
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('issueInvoice', () => {
  test('≥dust creates a reverse swap and never touches the plain path', async () => {
    globalThis.fetch = (async () => {
      throw new Error('plain path must not be used at/above dust')
    }) as unknown as typeof fetch
    const swaps = makeSwapsStub({
      createLightningInvoice: async (args) => {
        expect(args.amount).toBe(330)
        return fakeInvoiceResponse({ amount: 320, invoice: 'lnbc1u', paymentHash: 'aa'.repeat(32) })
      },
    })

    const issued = await issueInvoice(
      { swaps, wallet: makeWalletStub(), boltzApiUrl: 'http://boltz' },
      { amountSats: 330 },
    )

    expect(issued.kind).toBe('swap')
    if (issued.kind !== 'swap') throw new Error('unreachable')
    expect(issued.swapId).toBe('swap-id-fake')
    expect(issued.invoice).toBe('lnbc1u')
    expect(issued.paymentHash).toBe('aa'.repeat(32))
    expect(issued.receivedSats).toBe(320) // post-fee on-Ark amount
  })

  test('sub-dust posts to /v2/subdust/receive and decodes the returned invoice', async () => {
    let body: Record<string, unknown> | undefined
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('http://boltz/v2/subdust/receive')
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ invoice: INVOICE_2000_SAT })
    }) as unknown as typeof fetch

    // Default swaps stub throws on createLightningInvoice — proves the
    // reverse-swap path is never touched below dust.
    const issued = await issueInvoice(
      { swaps: makeSwapsStub(), wallet: makeWalletStub({ address: 'tark1me' }), boltzApiUrl: 'http://boltz' },
      { amountSats: 21, descriptionHash: 'cd'.repeat(32) },
    )

    expect(body).toEqual({ amount: 21, address: 'tark1me', descriptionHash: 'cd'.repeat(32) })
    expect(issued.kind).toBe('subdust')
    expect(issued.invoice).toBe(INVOICE_2000_SAT)
    expect(issued.receivedSats).toBe(21) // 1:1 — no swap fee on the plain path
    const decoded = decodeInvoice(INVOICE_2000_SAT)
    expect(issued.paymentHash).toBe(decoded.paymentHash)
    expect(issued.expiresAt).toBe(decoded.expiry)
  })
})

describe('reconcileSubdustReceives', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  const NOW = () => Math.floor(Date.now() / 1000)

  function insertRow(opts: {
    eventId: string
    swapId?: string
    expiresAt?: number | null
  }): string {
    const conn = createConnection(temp.db, { label: null, relays: ['wss://r'] }).connection
    const paymentHash = `ph-${opts.eventId}`
    temp.db
      .query(
        `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, swap_id, state, created_at, expires_at)
         VALUES (?, 'incoming', ?, 'lnbc-x', ?, 21000, ?, 'pending', 1, ?)`,
      )
      .run(conn.id, opts.eventId, paymentHash, opts.swapId ?? null, opts.expiresAt ?? null)
    return paymentHash
  }

  function rowState(paymentHash: string): { state: string; preimage: string | null; settled_at: number | null } | null {
    return temp.db
      .query<{ state: string; preimage: string | null; settled_at: number | null }, [string]>(
        'SELECT state, preimage, settled_at FROM transactions WHERE payment_hash = ?',
      )
      .get(paymentHash)
  }

  test('settled invoice flips the row with preimage + settled_at', async () => {
    const ph = insertRow({ eventId: 'sd-1' })
    globalThis.fetch = (async (url: unknown) => {
      expect(String(url)).toBe(`http://boltz/v2/subdust/receive/status?paymentHash=${ph}`)
      return Response.json({ settled: true, preimage: 'ab'.repeat(32) })
    }) as unknown as typeof fetch

    await reconcileSubdustReceives({ db: temp.db, boltzApiUrl: 'http://boltz' })

    const row = rowState(ph)
    expect(row?.state).toBe('settled')
    expect(row?.preimage).toBe('ab'.repeat(32))
    expect(typeof row?.settled_at).toBe('number')
  })

  test('unsettled + past expiry (beyond grace) → expired', async () => {
    const ph = insertRow({ eventId: 'sd-2', expiresAt: NOW() - 16 * 60 })
    globalThis.fetch = (async () => Response.json({ settled: false })) as unknown as typeof fetch

    await reconcileSubdustReceives({ db: temp.db, boltzApiUrl: 'http://boltz' })
    expect(rowState(ph)?.state).toBe('expired')
  })

  test('unsettled within the expiry grace window stays pending', async () => {
    const ph = insertRow({ eventId: 'sd-3', expiresAt: NOW() - 60 })
    globalThis.fetch = (async () => Response.json({ settled: false })) as unknown as typeof fetch

    await reconcileSubdustReceives({ db: temp.db, boltzApiUrl: 'http://boltz' })
    expect(rowState(ph)?.state).toBe('pending')
  })

  test('unsettled + not yet expired stays pending', async () => {
    const ph = insertRow({ eventId: 'sd-4', expiresAt: NOW() + 3600 })
    globalThis.fetch = (async () => Response.json({ settled: false })) as unknown as typeof fetch

    await reconcileSubdustReceives({ db: temp.db, boltzApiUrl: 'http://boltz' })
    expect(rowState(ph)?.state).toBe('pending')
  })

  test('boltz being down leaves the row pending for the next pass', async () => {
    const ph = insertRow({ eventId: 'sd-5', expiresAt: NOW() - 16 * 60 })
    globalThis.fetch = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch

    await reconcileSubdustReceives({ db: temp.db, boltzApiUrl: 'http://boltz' })
    // Even though it's past expiry, the flip is gated on a definitive
    // "unsettled" answer from boltz — no answer, no state change.
    expect(rowState(ph)?.state).toBe('pending')
  })

  test('rows with a swap_id (reverse swaps) are never polled', async () => {
    const ph = insertRow({ eventId: 'sd-6', swapId: 'swap-x' })
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return Response.json({ settled: true, preimage: 'ab'.repeat(32) })
    }) as unknown as typeof fetch

    await reconcileSubdustReceives({ db: temp.db, boltzApiUrl: 'http://boltz' })
    expect(calls).toBe(0)
    expect(rowState(ph)?.state).toBe('pending') // syncSwapToDb's job, not ours
  })
})
