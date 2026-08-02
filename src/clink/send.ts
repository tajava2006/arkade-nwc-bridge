import type { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'

import { decryptContent, encryptContent } from '../nostr/crypto'
import { isSafeRelayUrl, normalizeRelayUrl } from '../nostr/outbox'
import { nofferDecode, OfferPriceType } from './nip19_offer'

// CLINK Offers payer side: resolve a noffer to a BOLT11 by asking the offer
// service for an invoice. One-shot request/response (kind 21001) over the
// single relay baked into the code — not a persistent sub. Stateless: the
// caller folds the returned bolt11 into the normal Lightning send path.
// Spec: reference/CLINK/specs/clink-offers.md §General Process Flow.

const OFFER_KIND = 21001
const CLINK_VERSION = '1'
// CLINK is NIP-44 only.
const SCHEME = 'nip44_v2' as const
const DEFAULT_TIMEOUT_MS = 20_000

export type NofferResolveResult =
  | { ok: true; bolt11: string }
  // A CLINK error response (clink-offers.md §Error Codes). `latest` is set on a
  // code-3 (expired/moved) response that forwards to a fresh noffer.
  | { ok: false; kind: 'error'; code: number; message: string; range?: { min: number; max: number }; latest?: string }
  // No response in time, or the relay couldn't be reached at all.
  | { ok: false; kind: 'timeout'; relay: string }
  // The noffer string itself didn't decode.
  | { ok: false; kind: 'decode'; message: string }

/** Human-readable message for a failed resolve (clink-offers.md §Error Codes). */
export function clinkErrorMessage(r: Exclude<NofferResolveResult, { ok: true }>): string {
  if (r.kind === 'decode') return `invalid noffer: ${r.message}`
  if (r.kind === 'timeout') {
    return `couldn't reach the offer's relay (${r.relay}) — the code may be stale; ask the payee to regenerate it`
  }
  switch (r.code) {
    case 1:
      return 'offer is no longer valid (invalid offer)'
    case 2:
      return 'the payee service is temporarily unavailable — try again'
    case 3:
      return 'offer has expired'
    case 4:
      return `offer doesn't support this request: ${r.message}`
    case 5:
      return r.range
        ? `invalid amount — must be between ${r.range.min} and ${r.range.max} sats`
        : `invalid amount: ${r.message}`
    default:
      return `offer error (code ${r.code}): ${r.message}`
  }
}

export interface NofferRequestOpts {
  pool: SimplePool
  noffer: string
  /** Required for spontaneous/variable offers; ignored for fixed-price ones. */
  amountSats?: number
  timeoutMs?: number
}

/**
 * Ask a noffer's service for a BOLT11 invoice. Uses a fresh ephemeral key per
 * request (spec MAY — keeps the operator's payments unlinkable). Resolves with
 * the invoice, a typed CLINK error, a timeout (relay down / no reply), or a
 * decode failure — never rejects.
 */
export function requestNofferInvoice(opts: NofferRequestOpts): Promise<NofferResolveResult> {
  let pointer: ReturnType<typeof nofferDecode>
  try {
    pointer = nofferDecode(opts.noffer)
  } catch (err) {
    return Promise.resolve({
      ok: false,
      kind: 'decode',
      message: err instanceof Error ? err.message : String(err),
    })
  }

  // M7: a noffer's relay is chosen by the *counterparty* (the payee who handed
  // us the code), so it is attacker-influenced input that we'd otherwise connect
  // out to verbatim — an SSRF into internal ws(s) endpoints. Accept only a
  // safe relay URL (ws(s) scheme, non-loopback/private IP). A legit noffer's
  // relay is a public/wss relay (or a local dev `ws://localhost`, which passes —
  // hostnames aren't blocked).
  if (isSafeRelayUrl(pointer.relay) === false) {
    return Promise.resolve({
      ok: false,
      kind: 'decode',
      message: `noffer relay '${pointer.relay}' is not a safe relay URL — refusing to connect`,
    })
  }

  const relay = normalizeRelayUrl(pointer.relay)
  const secretKey = generateSecretKey()
  const publicKey = getPublicKey(secretKey)

  const payload: Record<string, unknown> = { offer: pointer.offer }
  // Fixed-price offers price themselves; only send an amount when the offer
  // lets the payer choose (spontaneous) or the service needs it (variable).
  if (pointer.priceType !== OfferPriceType.Fixed && opts.amountSats != null) {
    payload.amount_sats = opts.amountSats
  }

  const content = encryptContent(SCHEME, secretKey, pointer.pubkey, JSON.stringify(payload))
  const template: EventTemplate = {
    kind: OFFER_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', pointer.pubkey],
      ['clink_version', CLINK_VERSION],
    ],
    content,
  }
  const signed = finalizeEvent(template, secretKey)

  return new Promise<NofferResolveResult>((resolve) => {
    let done = false
    const finish = (r: NofferResolveResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      closer.close()
      resolve(r)
    }

    const timer = setTimeout(
      () => finish({ ok: false, kind: 'timeout', relay }),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )

    // Subscribe before publishing to avoid missing a fast reply. The response
    // is a kind-21001 addressed to us (#p) referencing our request (#e).
    const closer = opts.pool.subscribeMany(
      [relay],
      { kinds: [OFFER_KIND], '#p': [publicKey], '#e': [signed.id] },
      {
        onevent: (event) => {
          let res: {
            bolt11?: unknown
            error?: unknown
            code?: unknown
            range?: { min: number; max: number }
            latest?: unknown
          }
          try {
            res = JSON.parse(decryptContent(SCHEME, secretKey, pointer.pubkey, event.content))
          } catch {
            return // not for us / undecryptable — keep waiting
          }
          if (typeof res.bolt11 === 'string') {
            finish({ ok: true, bolt11: res.bolt11 })
          } else if (typeof res.code === 'number') {
            finish({
              ok: false,
              kind: 'error',
              code: res.code,
              message: typeof res.error === 'string' ? res.error : 'offer error',
              range: res.range,
              latest: typeof res.latest === 'string' ? res.latest : undefined,
            })
          }
          // unknown shape → ignore, keep waiting until timeout
        },
      },
    )

    // Publish after the sub is set up. If every relay rejects the publish, the
    // relay is unreachable — surface that immediately rather than wait out the
    // timeout.
    Promise.allSettled(opts.pool.publish([relay], signed)).then((results) => {
      if (!done && results.every((r) => r.status === 'rejected')) {
        finish({ ok: false, kind: 'timeout', relay })
      }
    })
  })
}
