// NIP-57 zap glue for the CLINK offer receiver.
//
// A CLINK offer request (clink/offers.ts) may carry a NIP-57 zap: the payer
// puts a signed kind-9734 event, JSON-stringified, in the request's `zap`
// field (clink-offers.md §NIP-57 Zaps). When it does, we:
//   1. validate the 9734 (NIP-57 Appendix D)                — validateZapRequest
//   2. commit SHA256(the exact 9734 string) into the invoice — zapDescriptionHash
//      as a descriptionHash (so the invoice's `h` field binds to the request)
//   3. on settlement, publish a kind-9735 zap receipt        — publishZapReceipt
//      to the relays named in the 9734.
//
// The one invariant that makes the receipt verify: the SAME byte string is
// hashed for (2) and carried verbatim as the 9735 `description` tag in (3), so
// SHA256(description) == the invoice's description hash (Appendix E). Never
// re-serialize the 9734 — store and reuse the exact string the payer sent.
//
// Spec: reference/nips/57.md, reference/CLINK/specs/clink-offers.md.

import { createHash } from 'node:crypto'
import type { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, verifyEvent, type EventTemplate, type NostrEvent } from 'nostr-tools/pure'

const ZAP_REQUEST_KIND = 9734
const ZAP_RECEIPT_KIND = 9735

/**
 * SHA256 (hex) over the EXACT zap-request bytes. This value goes into the
 * invoice as its descriptionHash; the same string is later carried verbatim as
 * the 9735 `description` tag, so SHA256(description) matches (NIP-57 App. E).
 */
export function zapDescriptionHash(zapRequest: string): string {
  return createHash('sha256').update(zapRequest, 'utf8').digest('hex')
}

export type ZapValidation = { ok: true; relays: string[] } | { ok: false; reason: string }

/**
 * Validate a stringified kind-9734 per NIP-57 Appendix D before we mint a
 * descriptionHash invoice for it. `amountSats` is the CLINK `amount_sats` the
 * payer named — the 9734's optional `amount` (millisats) must agree. `servicePub`
 * is the key we sign the 9735 with; an optional `P` tag must equal it.
 */
export function validateZapRequest(
  zapRequest: string,
  amountSats: number,
  servicePub: string,
): ZapValidation {
  let ev: NostrEvent
  try {
    ev = JSON.parse(zapRequest) as NostrEvent
  } catch {
    return { ok: false, reason: 'not JSON' }
  }

  if (ev.kind !== ZAP_REQUEST_KIND) return { ok: false, reason: `kind ${ev.kind} != 9734` }
  if (!Array.isArray(ev.tags) || ev.tags.length === 0) return { ok: false, reason: 'no tags' }

  try {
    if (!verifyEvent(ev)) return { ok: false, reason: 'invalid signature' }
  } catch {
    return { ok: false, reason: 'malformed event (verify threw)' }
  }

  const pTags = ev.tags.filter((t) => t[0] === 'p')
  if (pTags.length !== 1) return { ok: false, reason: `${pTags.length} p tags (need exactly 1)` }

  const eTags = ev.tags.filter((t) => t[0] === 'e')
  if (eTags.length > 1) return { ok: false, reason: `${eTags.length} e tags (max 1)` }

  const bigP = ev.tags.filter((t) => t[0] === 'P')
  if (bigP.length > 1) return { ok: false, reason: `${bigP.length} P tags (max 1)` }
  if (bigP.length === 1 && bigP[0]![1] !== servicePub) {
    return { ok: false, reason: 'P tag != service pubkey' }
  }

  // Appendix D §6: if an amount tag is present it MUST equal the requested
  // amount. 9734 amount is millisats; CLINK amount_sats is sats.
  const amountTag = ev.tags.find((t) => t[0] === 'amount')?.[1]
  if (amountTag !== undefined && amountTag !== String(amountSats * 1000)) {
    return { ok: false, reason: `amount tag ${amountTag} != ${amountSats * 1000} msat` }
  }

  // Where the 9735 gets published. A zap with nowhere to send the receipt is
  // useless to us, so treat a missing/empty relays tag as invalid.
  const relays = ev.tags.find((t) => t[0] === 'relays')?.slice(1) ?? []
  if (relays.length === 0) return { ok: false, reason: 'no relays tag' }

  return { ok: true, relays }
}

/**
 * Build + publish the NIP-57 kind-9735 zap receipt (Appendix E) to the relays
 * named in the zap request. Signed by our service key (the same key the payer's
 * client expects as the offer's nostrPubkey). Best-effort: if every relay
 * rejects it the receipt is lost, but the LN payment already happened — we log
 * and move on. Returns nothing; callers don't gate on delivery.
 */
export async function publishZapReceipt(
  deps: { pool: SimplePool; secretKey: Uint8Array },
  zapRequest: string,
  invoice: string,
  preimage?: string,
): Promise<void> {
  let ev: NostrEvent
  try {
    ev = JSON.parse(zapRequest) as NostrEvent
  } catch {
    console.warn('clink: stored zap_request is not JSON — skipping 9735')
    return
  }

  const relays = ev.tags.find((t) => t[0] === 'relays')?.slice(1) ?? []
  if (relays.length === 0) return

  // Copy `p` (recipient) plus any `e`/`a`/`k` straight from the 9734; `P` is the
  // zap sender (the request's own pubkey). The `description` tag is the exact
  // request string, so SHA256(description) == the invoice's descriptionHash.
  const tags: string[][] = []
  const p = ev.tags.find((t) => t[0] === 'p')
  if (p?.[1]) tags.push(['p', p[1]])
  for (const t of ev.tags) {
    if ((t[0] === 'e' || t[0] === 'a' || t[0] === 'k') && t[1] !== undefined) tags.push([t[0], t[1]])
  }
  tags.push(['P', ev.pubkey])
  tags.push(['bolt11', invoice])
  tags.push(['description', zapRequest])
  if (preimage) tags.push(['preimage', preimage])

  const template: EventTemplate = {
    kind: ZAP_RECEIPT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }
  const signed = finalizeEvent(template, deps.secretKey)
  const results = await Promise.allSettled(deps.pool.publish(relays, signed))
  if (!results.some((r) => r.status === 'fulfilled')) {
    console.warn(`clink: 9735 zap receipt rejected by all relays [${relays.join(', ')}]`)
  } else {
    console.log(`clink: published 9735 zap receipt to ${relays.length} relay(s)`)
  }
}
