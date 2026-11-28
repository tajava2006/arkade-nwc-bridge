import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { SqliteAtomicSwapRepository } from '../../src/atomic'
import { issueInvoice } from '../../src/ln_receive'
import { openTempDb, type TempDb } from '../helpers/db'
import { makeWalletStub, stubSubdustdReceive } from '../helpers/mocks'

// The LN-receive core (D10): every amount is an atomic receive against
// subdustd. What this pins offline: the request subdustd gets (amount, our
// payment hash, the description XOR its hash), the swap persisted before the
// invoice is handed out (claim secrets must outlive a crash), and the 1:1
// result. The claim/settle half runs on regtest (subdustd_receive, ln_receive).

const SUBDUSTD = 'http://subdustd.invalid'
const realFetch = globalThis.fetch
let temp: TempDb
beforeEach(() => {
  temp = openTempDb()
})
afterEach(() => {
  globalThis.fetch = realFetch
  temp.cleanup()
})

const deps = () => ({ wallet: makeWalletStub(), subdustdUrl: SUBDUSTD, arkServerUrl: 'http://arkd.invalid', db: temp.db })
const sha256 = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')

describe('issueInvoice — atomic receive for every amount', () => {
  for (const amount of [21, 330, 50_000]) {
    test(`${amount} sats: subdustd mints it, the swap is persisted with our preimage, 1:1`, async () => {
      const { bodies } = stubSubdustdReceive(SUBDUSTD)
      const issued = await issueInvoice(deps(), { amountSats: amount, description: 'tea' })
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject({ amount, description: 'tea' })
      expect(bodies[0]!.descriptionHash).toBeUndefined()
      expect(issued.kind).toBe('subdust')
      expect(issued.receivedSats).toBe(amount)
      expect(sha256(issued.preimage)).toBe(issued.paymentHash)
      expect(bodies[0]!.paymentHash).toBe(issued.paymentHash)
      const row = new SqliteAtomicSwapRepository(temp.db).getByPaymentHash(issued.paymentHash)
      expect(row).toMatchObject({ state: 'invoice_issued', amount, preimage: issued.preimage, invoice: issued.invoice })
    })
  }

  test('F32: a 4-leaf offer at 330+ sats is refused — no invoice is handed out, no row kept', async () => {
    for (const [amount, script] of [[330, 'atomic4'], [50_000, undefined]] as const) {
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { paymentHash: string }
        return new Response(JSON.stringify({ swapId: `old-${amount}`, invoice: 'lnbcrt1x', ...(script ? { script } : {}), _h: body.paymentHash }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch
      const err = await issueInvoice(deps(), { amountSats: amount, description: 'x' }).catch((e) => e)
      expect(String(err)).toContain('only a VHTLC protects it')
      expect(new SqliteAtomicSwapRepository(temp.db).get(`old-${amount}`)).toBeUndefined()
    }
  })

  test('a NIP-57 description hash goes alone — the plain description is dropped, never both', async () => {
    const { bodies } = stubSubdustdReceive(SUBDUSTD)
    await issueInvoice(deps(), { amountSats: 1_000, description: 'zap', descriptionHash: 'ab'.repeat(32) })
    expect(bodies[0]!.descriptionHash).toBe('ab'.repeat(32))
    expect(bodies[0]!.description).toBeUndefined()
  })

  test('a subdustd refusal (float cannot fund it) surfaces and persists nothing', async () => {
    globalThis.fetch = (async () => new Response('cannot fund a receive right now', { status: 503 })) as unknown as typeof fetch
    await expect(issueInvoice(deps(), { amountSats: 1_000 })).rejects.toThrow(/503/)
    expect(new SqliteAtomicSwapRepository(temp.db).list()).toEqual([])
  })
})
