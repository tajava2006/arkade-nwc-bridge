import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { LnSendRefused, sendLightning } from '../../src/ln_send'
import { INVOICE_21_SAT, INVOICE_2000_SAT, INVOICE_NO_AMOUNT, makeWalletStub } from '../helpers/mocks'

// The single LN-send entry point (NWC pay_invoice + dashboard /send). Since D11
// every amount takes the atomic send against subdustd; the send itself needs
// arkd and subdustd and is covered on regtest (subdustd_send, ln_send, drill).
// Here: what is refused before anything is asked, and that both a sub-dust and a
// dust+ amount go to the atomic path.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const base = {
  arkServerUrl: 'http://arkd.invalid',
  db: new Database(':memory:'),
  wallet: makeWalletStub(),
  lightning: { subdustdUrl: 'http://subdustd.invalid' },
}

const offline = () => {
  const hit: string[] = []
  globalThis.fetch = (async (url: string) => {
    hit.push(String(url))
    throw new Error('offline')
  }) as unknown as typeof fetch
  return hit
}

describe('sendLightning', () => {
  test('amountless and malformed invoices are refused before anything is asked', async () => {
    const hit = offline()
    expect(await sendLightning(base, INVOICE_NO_AMOUNT).catch((e) => e)).toBeInstanceOf(LnSendRefused)
    expect(await sendLightning(base, 'lnbc-not-an-invoice').catch((e) => e)).toBeInstanceOf(LnSendRefused)
    expect(hit).toEqual([])
  })

  test('sub-dust and dust+ alike take the atomic path (D11)', async () => {
    for (const invoice of [INVOICE_21_SAT, INVOICE_2000_SAT]) {
      const hit = offline()
      const err = await sendLightning(base, invoice).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(LnSendRefused) // nothing to refuse on: it tried
      expect(hit.some((u) => u.startsWith('http://arkd.invalid') || u.startsWith('http://subdustd.invalid'))).toBe(true)
    }
  })
})
