import { describe, expect, test } from 'bun:test'
import { bech32 } from '@scure/base'
import { finalizeEvent, getPublicKey, verifyEvent, type NostrEvent } from 'nostr-tools/pure'
import type { SimplePool } from 'nostr-tools/pool'

import {
  OfferPriceType,
  nofferDecode,
  nofferEncode,
  type OfferPointer,
} from '../../src/clink/nip19_offer'
import {
  publishZapReceipt,
  validateZapRequest,
  zapDescriptionHash,
} from '../../src/clink/zap'
import { sendOfferReceipt } from '../../src/clink/offers'
import type { BoltzReverseSwap } from '@arkade-os/boltz-swap'
import { openTempDb } from '../helpers/db'

// The noffer codec is vendored TLV/bech32 framing (the error-prone part) and
// the 9735 receipt is what makes zaps VISIBLE on Nostr clients — a silently
// malformed receipt loses the zap without failing anything. Both are pure,
// both drift-prone across `bun run upgrade`, so both get pinned here.

const PAYER_SK = new Uint8Array(32).fill(7)
const PAYER_PUB = getPublicKey(PAYER_SK)
const SERVICE_SK = new Uint8Array(32).fill(9)
const SERVICE_PUB = getPublicKey(SERVICE_SK)

describe('noffer codec', () => {
  const pointer: OfferPointer = {
    pubkey: SERVICE_PUB,
    relay: 'wss://relay.example',
    offer: 'zap-me',
    priceType: OfferPriceType.Spontaneous,
  }

  test('round-trips a spontaneous offer (no price TLV)', () => {
    const code = nofferEncode(pointer)
    expect(code.startsWith('noffer1')).toBe(true)
    expect(nofferDecode(code)).toEqual({ ...pointer, price: undefined })
  })

  test('round-trips a fixed price (32-bit big-endian TLV 4)', () => {
    const priced: OfferPointer = {
      ...pointer,
      priceType: OfferPriceType.Fixed,
      price: 21_000_000, // >3 bytes — catches endianness/width mistakes
    }
    expect(nofferDecode(nofferEncode(priced))).toEqual(priced)
  })

  test('rejects a non-noffer prefix', () => {
    const { words } = bech32.decode(nofferEncode(pointer) as never, 5000)
    const wrong = bech32.encode('nprofile', words, 5000)
    expect(() => nofferDecode(wrong)).toThrow(/expected noffer/)
  })

  test('rejects truncated TLV payloads instead of mis-parsing them', () => {
    const { words } = bech32.decode(nofferEncode(pointer) as never, 5000)
    const bytes = new Uint8Array(bech32.fromWords(words)).slice(0, -3)
    const chopped = bech32.encode('noffer', bech32.toWords(bytes), 5000)
    expect(() => nofferDecode(chopped)).toThrow()
  })
})

// A realistic signed 9734, tweakable per test.
function makeZapRequest(over: { tags?: string[][]; content?: string } = {}): string {
  const ev = finalizeEvent(
    {
      kind: 9734,
      created_at: 1_700_000_000,
      content: over.content ?? '',
      tags: over.tags ?? [
        ['p', SERVICE_PUB],
        ['e', 'ab'.repeat(32)],
        ['relays', 'wss://r1.example', 'wss://r2.example'],
        ['amount', '21000'], // msat — 21 sats
      ],
    },
    PAYER_SK,
  )
  return JSON.stringify(ev)
}

describe('validateZapRequest (NIP-57 Appendix D)', () => {
  test('accepts a well-formed request and returns its receipt relays', () => {
    const v = validateZapRequest(makeZapRequest(), 21, SERVICE_PUB)
    expect(v).toEqual({ ok: true, relays: ['wss://r1.example', 'wss://r2.example'] })
  })

  test('rejects an amount tag that disagrees with the CLINK amount', () => {
    const v = validateZapRequest(makeZapRequest(), 22, SERVICE_PUB)
    expect(v.ok).toBe(false)
  })

  test('rejects a tampered signature', () => {
    const ev = JSON.parse(makeZapRequest()) as NostrEvent
    ev.content = 'tampered'
    const v = validateZapRequest(JSON.stringify(ev), 21, SERVICE_PUB)
    expect(v).toEqual({ ok: false, reason: 'invalid signature' })
  })

  test('rejects multiple p tags / missing relays / foreign P tag', () => {
    const twoP = makeZapRequest({
      tags: [['p', SERVICE_PUB], ['p', PAYER_PUB], ['relays', 'wss://r'], ['amount', '21000']],
    })
    expect(validateZapRequest(twoP, 21, SERVICE_PUB).ok).toBe(false)

    const noRelays = makeZapRequest({ tags: [['p', SERVICE_PUB], ['amount', '21000']] })
    expect(validateZapRequest(noRelays, 21, SERVICE_PUB).ok).toBe(false)

    const foreignP = makeZapRequest({
      tags: [['p', SERVICE_PUB], ['P', PAYER_PUB], ['relays', 'wss://r'], ['amount', '21000']],
    })
    expect(validateZapRequest(foreignP, 21, SERVICE_PUB).ok).toBe(false)
  })

  test('rejects non-JSON and wrong kinds', () => {
    expect(validateZapRequest('not json', 21, SERVICE_PUB).ok).toBe(false)
    const ev = finalizeEvent(
      { kind: 1, created_at: 1, content: '', tags: [['p', SERVICE_PUB]] },
      PAYER_SK,
    )
    expect(validateZapRequest(JSON.stringify(ev), 21, SERVICE_PUB).ok).toBe(false)
  })
})

describe('publishZapReceipt (NIP-57 Appendix E)', () => {
  function capturePool(): { pool: SimplePool; published: { relays: string[]; ev: NostrEvent }[] } {
    const published: { relays: string[]; ev: NostrEvent }[] = []
    const pool = {
      publish(relays: string[], ev: NostrEvent) {
        published.push({ relays, ev })
        return relays.map(() => Promise.resolve('ok'))
      },
    } as unknown as SimplePool
    return { pool, published }
  }

  test('receipt binds to the invoice via SHA256(description) == descriptionHash', async () => {
    const zapRequest = makeZapRequest()
    const { pool, published } = capturePool()
    await publishZapReceipt(
      { pool, secretKey: SERVICE_SK },
      zapRequest,
      'lnbc21fake',
      'cd'.repeat(32),
    )

    expect(published).toHaveLength(1)
    const { relays, ev } = published[0]!
    expect(relays).toEqual(['wss://r1.example', 'wss://r2.example'])
    expect(ev.kind).toBe(9735)
    expect(ev.pubkey).toBe(SERVICE_PUB) // signed by the offer's advertised key
    expect(verifyEvent(ev)).toBe(true)

    const tag = (name: string) => ev.tags.find((t) => t[0] === name)
    // THE invariant: the description tag is the exact request string, so a
    // client hashing it reproduces the invoice's descriptionHash
    expect(tag('description')![1]).toBe(zapRequest)
    expect(zapDescriptionHash(tag('description')![1]!)).toBe(zapDescriptionHash(zapRequest))
    expect(tag('p')![1]).toBe(SERVICE_PUB)
    expect(tag('P')![1]).toBe(PAYER_PUB) // zap sender
    expect(tag('e')![1]).toBe('ab'.repeat(32)) // copied from the 9734
    expect(tag('bolt11')![1]).toBe('lnbc21fake')
    expect(tag('preimage')![1]).toBe('cd'.repeat(32))
  })

  test('a request without relays publishes nothing (nowhere to send it)', async () => {
    const zapRequest = makeZapRequest({ tags: [['p', SERVICE_PUB]] })
    const { pool, published } = capturePool()
    await publishZapReceipt({ pool, secretKey: SERVICE_SK }, zapRequest, 'lnbc21fake')
    expect(published).toHaveLength(0)
  })
})

describe('sendOfferReceipt operator DM', () => {
  const stubPool = (): SimplePool =>
    ({
      publish: (relays: string[]) => relays.map(() => Promise.resolve('ok')),
    }) as unknown as SimplePool

  const SWAP = {
    id: 'swap-dm-1',
    preimage: 'aa'.repeat(32),
    request: { invoiceAmount: 500 },
  } as unknown as BoltzReverseSwap

  function insertReceiptRow(
    db: import('bun:sqlite').Database,
    over: { zapRequest?: string | null; zapInvoice?: string | null } = {},
  ): void {
    db.query(
      `INSERT INTO clink_offer_receipts (swap_id, payer_pubkey, request_id, relay, zap_request, zap_invoice, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SWAP.id,
      PAYER_PUB,
      'req-1',
      'wss://r',
      over.zapRequest ?? null,
      over.zapInvoice ?? null,
      Math.floor(Date.now() / 1000),
    )
  }

  test('zap: payer npub + 9734 amount (msat→sat) + comment, exactly once', async () => {
    const temp = openTempDb()
    try {
      insertReceiptRow(temp.db, {
        zapRequest: JSON.stringify({
          pubkey: PAYER_PUB,
          content: 'gm',
          tags: [['amount', '21000']],
        }),
        zapInvoice: 'lnbc21fake',
      })
      const calls: Array<{ kind: string; text: string }> = []
      const deps = {
        pool: stubPool(),
        db: temp.db,
        secretKey: SERVICE_SK,
        notify: (kind: string, build: () => string) => calls.push({ kind, text: build() }),
      }
      await sendOfferReceipt(deps as never, SWAP)
      expect(calls.length).toBe(1)
      expect(calls[0]!.kind).toBe('recv-noffer')
      expect(calls[0]!.text).toContain('zap 21 sats')
      expect(calls[0]!.text).toContain('"gm"')
      expect(calls[0]!.text).toContain('npub1')

      // The row DELETE is the dedup — a reconcile pass re-running the same
      // swap finds nothing and stays silent.
      await sendOfferReceipt(deps as never, SWAP)
      expect(calls.length).toBe(1)
    } finally {
      temp.cleanup()
    }
  })

  test('plain noffer payment falls back to the swap invoice amount', async () => {
    const temp = openTempDb()
    try {
      insertReceiptRow(temp.db)
      const calls: Array<{ kind: string; text: string }> = []
      await sendOfferReceipt(
        {
          pool: stubPool(),
          db: temp.db,
          secretKey: SERVICE_SK,
          notify: ((kind: string, build: () => string) =>
            calls.push({ kind, text: build() })) as never,
        },
        SWAP,
      )
      expect(calls.length).toBe(1)
      expect(calls[0]!.text).toContain('noffer payment 500 sats')
    } finally {
      temp.cleanup()
    }
  })
})
