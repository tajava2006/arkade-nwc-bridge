import { afterEach, describe, expect, test } from 'bun:test'

import { sendLightning } from '../../src/ln_send'
import {
  INVOICE_21_SAT,
  INVOICE_328_SAT,
  INVOICE_2000_SAT,
  INVOICE_NO_AMOUNT,
  fakeSpendableVtxo,
  fakeSubmarineSwap,
  makeSwapsStub,
  makeWalletStub,
} from '../helpers/mocks'

// The single LN-send entry point (NWC pay_invoice + dashboard /send both
// funnel here). The ≥dust submarine flow is also exercised through
// handlers.test; THIS file owns the branches nothing else covers — the
// sub-dust plain path (the outbound half of the 21-sat zap feature, until
// now mainnet-verified exactly once and never pinned) and the
// drain/insufficient funding edges on both rails.

// Sub-dust talks to boltz over plain fetch — intercept per test, restore.
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/**
 * Wire up the boltz sub-dust REST pair: GET /v2/subdust/address?invoice= →
 * bound address, POST /v2/subdust/send → preimage. Captures the POST body
 * and refuses anything unexpected.
 */
function mockSubdustBoltz(opts: { boundAddress?: string; failSend?: number } = {}) {
  const calls: { gets: string[]; postBody?: Record<string, unknown> } = { gets: [] }
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith('http://boltz/v2/subdust/address?invoice=')) {
      calls.gets.push(u)
      return Response.json({ address: opts.boundAddress ?? 'tark1bound' })
    }
    if (u === 'http://boltz/v2/subdust/send') {
      if (opts.failSend) return new Response('lightning payment failed', { status: opts.failSend })
      calls.postBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ paid: true, preimage: 'ab'.repeat(32) })
    }
    throw new Error(`unexpected fetch: ${u}`)
  }) as unknown as typeof fetch
  return calls
}

describe('sendLightning — sub-dust plain path (<330 sats)', () => {
  test('funds the invoice-bound address and pays via /v2/subdust/send', async () => {
    const boltz = mockSubdustBoltz()
    const sends: { address: string; amount: number }[] = []
    const wallet = makeWalletStub({
      address: 'tark1me',
      vtxos: [fakeSpendableVtxo(10_000)],
      sendImpl: async (args) => {
        sends.push(args)
        return 'arktxid-funding'
      },
    })

    // default fee stub: submarine 0.1% → ceil(21 × 0.001) = 1 sat fee
    const res = await sendLightning(
      { swaps: makeSwapsStub(), wallet, boltzApiUrl: 'http://boltz' },
      INVOICE_21_SAT,
    )

    // funding goes to the per-invoice bound address, invoice + fee exactly
    expect(sends).toEqual([{ address: 'tark1bound', amount: 22 }])
    expect(boltz.gets[0]).toContain(encodeURIComponent(INVOICE_21_SAT))
    // boltz gets the funding txid (its dedup key), the invoice, and OUR
    // address for the refund-on-terminal-failure path
    expect(boltz.postBody).toEqual({
      arkTxid: 'arktxid-funding',
      invoice: INVOICE_21_SAT,
      refundAddress: 'tark1me',
    })
    expect(res).toEqual({ amount: 22, preimage: 'ab'.repeat(32), txid: 'arktxid-funding' })
  })

  test('near-drain folds the residue into the funding (no stranded sub-dust change)', async () => {
    // The realistic drain shape: only vtxos ≥330 count as spendable, so a
    // near-drain on the sub-dust rail means a near-dust invoice against a
    // near-dust wallet — 328-sat invoice + 1 fee = 329 vs one 330-sat vtxo.
    mockSubdustBoltz()
    const sends: { address: string; amount: number }[] = []
    const wallet = makeWalletStub({
      vtxos: [fakeSpendableVtxo(330)], // required 329, surplus 1 ≤ slack
      sendImpl: async (args) => {
        sends.push(args)
        return 'arktxid-funding'
      },
    })
    const res = await sendLightning(
      { swaps: makeSwapsStub(), wallet, boltzApiUrl: 'http://boltz' },
      INVOICE_328_SAT,
    )
    expect(sends[0]!.amount).toBe(330) // all-in — boltz keeps the 1-sat residue
    expect(res.amount).toBe(330)
  })

  test('surplus above the slack stays in the wallet as normal change', async () => {
    mockSubdustBoltz()
    const sends: { address: string; amount: number }[] = []
    const wallet = makeWalletStub({
      vtxos: [fakeSpendableVtxo(340)], // required 329, surplus 11 > slack
      sendImpl: async (args) => {
        sends.push(args)
        return 'arktxid-funding'
      },
    })
    await sendLightning(
      { swaps: makeSwapsStub(), wallet, boltzApiUrl: 'http://boltz' },
      INVOICE_328_SAT,
    )
    expect(sends[0]!.amount).toBe(329) // exact requirement, 11 sats stay home
  })

  test('sub-dust vtxos do not count as spendable — readable shortfall error', async () => {
    const boltz = mockSubdustBoltz()
    // 329 is itself sub-dust: in the wallet.send pool but round-only, so the
    // 22-sat requirement is genuinely unfundable despite value being present
    const wallet = makeWalletStub({
      vtxos: [fakeSpendableVtxo(329)],
      sendImpl: async () => {
        throw new Error('must not reach wallet.send')
      },
    })
    await expect(
      sendLightning({ swaps: makeSwapsStub(), wallet, boltzApiUrl: 'http://boltz' }, INVOICE_21_SAT),
    ).rejects.toThrow(/needs 22 sats .* 0 sats are offchain-spendable/)
    expect(boltz.postBody).toBeUndefined() // nothing was paid
  })

  test('boltz refusing the pay surfaces with url + status (funding already out)', async () => {
    mockSubdustBoltz({ failSend: 502 })
    const wallet = makeWalletStub({ vtxos: [fakeSpendableVtxo(10_000)] })
    await expect(
      sendLightning({ swaps: makeSwapsStub(), wallet, boltzApiUrl: 'http://boltz' }, INVOICE_21_SAT),
    ).rejects.toThrow(/subdust\/send -> 502/)
  })
})

describe('sendLightning — submarine rail (≥ dust / amountless)', () => {
  test('near-drain overfunds the lockup instead of stranding change', async () => {
    const swaps = makeSwapsStub({
      createSubmarineSwap: async () => fakeSubmarineSwap({ expectedAmount: 2005 }),
      waitForSwapSettlement: async () => ({ preimage: 'cd'.repeat(32) }),
    })
    const sends: { address: string; amount: number }[] = []
    const wallet = makeWalletStub({
      vtxos: [fakeSpendableVtxo(2006)], // 1 sat over — inside the slack
      sendImpl: async (args) => {
        sends.push(args)
        return 'arktxid-lockup'
      },
    })
    const res = await sendLightning({ swaps, wallet, boltzApiUrl: '' }, INVOICE_2000_SAT)
    expect(sends[0]).toEqual({ address: 'tark1boltzlockup', amount: 2006 })
    expect(res).toEqual({ amount: 2006, preimage: 'cd'.repeat(32), txid: 'arktxid-lockup' })
  })

  test('an amountless invoice routes submarine, never the plain path', async () => {
    globalThis.fetch = (async () => {
      throw new Error('plain path must not be used for amountless invoices')
    }) as unknown as typeof fetch
    const swaps = makeSwapsStub({
      createSubmarineSwap: async (args) => {
        expect(args.invoice).toBe(INVOICE_NO_AMOUNT)
        return fakeSubmarineSwap({ expectedAmount: 500 })
      },
      waitForSwapSettlement: async () => ({ preimage: 'ee'.repeat(32) }),
    })
    const wallet = makeWalletStub({ vtxos: [fakeSpendableVtxo(10_000)] })
    const res = await sendLightning({ swaps, wallet, boltzApiUrl: '' }, INVOICE_NO_AMOUNT)
    expect(res.amount).toBe(500)
  })

  test('a swap response without an address is a hard error before any send', async () => {
    const swaps = makeSwapsStub({
      createSubmarineSwap: async () => fakeSubmarineSwap({ address: '' }),
    })
    const wallet = makeWalletStub({
      vtxos: [fakeSpendableVtxo(10_000)],
      sendImpl: async () => {
        throw new Error('must not reach wallet.send')
      },
    })
    await expect(
      sendLightning({ swaps, wallet, boltzApiUrl: '' }, INVOICE_2000_SAT),
    ).rejects.toThrow(/missing address/)
  })
})
