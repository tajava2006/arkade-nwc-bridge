import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { LnSendRefused, LnSendUnresolved, sendLightning } from '../../src/ln_send'
import { INVOICE_21_SAT, INVOICE_NO_AMOUNT, knownPreimageInvoice, makeLightningStub, makeWalletStub } from '../helpers/mocks'

// The single LN-send entry point (NWC pay_invoice + dashboard /send). This file
// owns the rail choice and the solver-path result/errors; the solver itself is
// scripted (makeLightningStub) — the real one is exercised on regtest
// (test/regtest/solver_rail.test.ts, ln_send regtest). The sub-dust branch runs
// the atomic send against subdustd, covered by the subdustd regtest suites.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const base = { arkServerUrl: 'http://arkd.invalid', db: new Database(':memory:'), wallet: makeWalletStub() }

describe('sendLightning — solver rail (≥ dust)', () => {
  test('paid: what left the wallet, the hash-verified preimage, the lockup txid, the swap id', async () => {
    const { preimage, invoice } = knownPreimageInvoice()
    const { lightning, paid } = makeLightningStub({ feeSats: 5, preimage })
    const linked: string[] = []
    const res = await sendLightning({ ...base, lightning, onSwapCreated: (id) => linked.push(id) }, invoice)
    expect(paid).toEqual([invoice])
    expect(res).toEqual({ amount: 2005, preimage, txid: 'arktxid-lockup', swapId: 'rfq:00112233445566778899aabbccddeeff' })
    expect(linked).toEqual(['rfq:00112233445566778899aabbccddeeff'])
  })

  test('a stored preimage that does not hash to the invoice is never returned', async () => {
    const { invoice } = knownPreimageInvoice()
    const { lightning } = makeLightningStub({ preimage: 'ab'.repeat(32) })
    // Falls through to the chain read (arkd's indexer), unreachable offline.
    const hit: string[] = []
    globalThis.fetch = (async (url: string) => {
      hit.push(String(url))
      throw new Error('offline')
    }) as unknown as typeof fetch
    await expect(sendLightning({ ...base, lightning }, invoice)).rejects.toThrow()
    expect(hit.length).toBeGreaterThan(0)
    expect(hit.every((u) => u.startsWith('http://arkd.invalid'))).toBe(true)
  })

  test('refunded: a plain failure (the row can be failed)', async () => {
    const { invoice } = knownPreimageInvoice()
    const { lightning } = makeLightningStub({ finalOutcome: 'refunded' })
    const err = await sendLightning({ ...base, lightning }, invoice).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(LnSendUnresolved)
    expect((err as Error).message).toMatch(/refunded: no route/)
  })

  test('needs_recovery: unresolved — the caller must keep the row pending', async () => {
    const { invoice } = knownPreimageInvoice()
    const { lightning } = makeLightningStub({ finalOutcome: 'needs_recovery' })
    expect(await sendLightning({ ...base, lightning }, invoice).catch((e) => e)).toBeInstanceOf(LnSendUnresolved)
  })

  test('a solver refusal before value moves is LnSendRefused, insufficient funds flagged', async () => {
    const { invoice } = knownPreimageInvoice()
    const refusal = Object.assign(new Error('balance 10 < 2000'), { name: 'InsufficientFunds' })
    // isSwapError keys on the class registry; mimic one the SDK recognizes.
    const { InsufficientFunds } = await import('@arkade-os/swap')
    const real = Object.setPrototypeOf(refusal, InsufficientFunds.prototype)
    const { lightning } = makeLightningStub({ payError: real })
    const err = await sendLightning({ ...base, lightning }, invoice).catch((e) => e)
    expect(err).toBeInstanceOf(LnSendRefused)
    expect((err as LnSendRefused).insufficientFunds).toBe(true)
  })
})

describe('sendLightning — rail choice', () => {
  test('amountless invoices are refused before any rail is touched', async () => {
    const { lightning, paid } = makeLightningStub()
    expect(await sendLightning({ ...base, lightning }, INVOICE_NO_AMOUNT).catch((e) => e)).toBeInstanceOf(LnSendRefused)
    expect(paid).toEqual([])
  })

  test('a sub-dust amount never reaches the solver (it would strand on claim) — it goes to subdustd', async () => {
    const { lightning, paid } = makeLightningStub()
    const hit: string[] = []
    globalThis.fetch = (async (url: string) => {
      hit.push(String(url))
      throw new Error('offline')
    }) as unknown as typeof fetch
    await sendLightning({ ...base, lightning }, INVOICE_21_SAT).catch(() => {})
    expect(paid).toEqual([])
    expect(hit.some((u) => u.startsWith('http://arkd.invalid') || u.startsWith('http://subdustd.invalid'))).toBe(true)
  })
})
