import type { Database } from 'bun:sqlite'
import type { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure'
import {
  NetworkError,
  decodeInvoice,
  isReverseFinalStatus,
  isReverseSuccessStatus,
  type ArkadeSwaps,
  type BoltzReverseSwap,
  type BoltzSwapStatus,
} from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'

import { CLINK_OFFER_ID } from '../defaults'
import { decryptContent, encryptContent } from '../nostr/crypto'
import { openPersistentSub, type PersistentSub } from '../nostr/persistent_sub'
import { normalizeRelayUrl, type OutboxWatcher } from '../nostr/outbox'
import type { RelayStatus } from '../lib/relay_status'
import { nofferEncode, nofferDecode, OfferPriceType } from './nip19_offer'

// CLINK Offers (noffer) receiver — the *server* half the SDK doesn't ship.
// One static spontaneous-price offer served under the account key: a payer
// sends a kind-21001 request naming an amount, we mint a reverse-swap BOLT11
// (lands on Ark) and reply over Nostr. No public web endpoint, no LNURL.
//
// The noffer is minted from outbox relay [0] and the encoded string is
// stored (clink_offer table); on boot we decode it and listen on the relay
// frozen into that code — not the live outbox, which may have drifted. A
// noffer carries only one relay (spec TLV 1), so that relay is the single
// point of contact: if it dies the operator regenerates by hand (dashboard
// shows its status). Spec: reference/CLINK/specs/clink-offers.md.
//
// Phase 2 (not here): NIP-57 zap payload (9734) + 9735 receipt on settlement,
// and the optional post-payment receipt (kind 21001 {res:ok,preimage}).

const OFFER_KIND = 21001
const CLINK_VERSION = '1'

// Bitcoin P2TR standard dust. Below this a Boltz reverse swap can't settle: the
// vHTLC lockup vtxo is sub-dust, arkd marks it VTXO_RECOVERABLE and rejects the
// claim's spend, so the swap strands. Sub-dust receives take the operator's
// plain-invoice path instead (see handleOfferRequest + boltz-subdust-receive.patch).
const DUST_SATS = 330

// CLINK is NIP-44 only (unlike NWC, which also speaks legacy nip04).
const SCHEME = 'nip44_v2' as const

// Spec error codes (clink-offers.md §Error Codes).
const ERR_INVALID_OFFER = 1
const ERR_TEMPORARY = 2
const ERR_INVALID_AMOUNT = 5

interface OfferRequestPayload {
  offer?: string
  amount_sats?: number
  description?: string
  zap?: string
  expires_in_seconds?: number
  payer_data?: unknown
}

export interface OfferService {
  /** The current static noffer1… code and the single relay baked into it. */
  snapshot(): { noffer: string; relay: string }
  /** Live connection state of the noffer's relay (for the dashboard badge). */
  getRelayStatus(): RelayStatus
  /**
   * Mint a fresh noffer from the operator's *current* outbox relay, persist
   * it (replacing the old row), and move the subscription to the new relay.
   * Operator-initiated only — regenerating invalidates every previously
   * shared copy of the code, so it's a deliberate "this relay is dead, rotate
   * it" action, never automatic.
   */
  regenerate(): void
  stop(): void
}

export interface OfferServiceDeps {
  pool: SimplePool
  db: Database
  /** Account secret — same key the Ark wallet uses; signs/decrypts offers. */
  secretKey: Uint8Array
  outbox: OutboxWatcher
  swaps: ArkadeSwaps
  /** Ark wallet — sub-dust receives are paid out to its address by Boltz. */
  wallet: Wallet
  /** Boltz REST base (no /v2 suffix); the sub-dust receive route lives there. */
  boltzApiUrl: string
}

function loadStoredNoffer(db: Database): string | null {
  return db.query<{ noffer: string }, []>('SELECT noffer FROM clink_offer WHERE id = 1').get()?.noffer ?? null
}

function saveNoffer(db: Database, noffer: string): void {
  db.query(
    `INSERT INTO clink_offer (id, noffer, created_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET noffer = excluded.noffer, created_at = excluded.created_at`,
  ).run(noffer, Math.floor(Date.now() / 1000))
}

function mint(secretKey: Uint8Array, outbox: OutboxWatcher): { noffer: string; relay: string } {
  const relays = outbox.getOutboxRelays()
  if (relays.length === 0) throw new Error('clink: no outbox relays available to mint a noffer')
  const relay = normalizeRelayUrl(relays[0]!)
  const noffer = nofferEncode({
    pubkey: getPublicKey(secretKey),
    relay,
    offer: CLINK_OFFER_ID,
    priceType: OfferPriceType.Spontaneous,
  })
  return { noffer, relay }
}

export function startOfferService(deps: OfferServiceDeps): OfferService {
  const { pool, db, secretKey, outbox, swaps, wallet, boltzApiUrl } = deps
  const pub = getPublicKey(secretKey)

  // Reuse the stored code iff it decodes and was minted under this account
  // key; otherwise (none / corrupt / account changed) mint a fresh one.
  let current: { noffer: string; relay: string } | null = null
  const stored = loadStoredNoffer(db)
  if (stored) {
    try {
      const dec = nofferDecode(stored)
      if (dec.pubkey === pub) {
        current = { noffer: stored, relay: dec.relay }
      } else {
        console.warn('clink: stored noffer pubkey != account key — regenerating')
      }
    } catch (err) {
      console.warn('clink: stored noffer could not be decoded — regenerating:', err)
    }
  }
  if (!current) {
    current = mint(secretKey, outbox)
    saveNoffer(db, current.noffer)
  }
  const state = current

  let sub: PersistentSub | null = null
  const openSub = (): void => {
    sub = openPersistentSub({
      pool,
      relays: [state.relay],
      label: 'clink-offer',
      filter: { kinds: [OFFER_KIND], '#p': [pub] },
      // Serve requests that landed while the relay was briefly down. Worst
      // case is an invoice nobody waits for — harmless, no funds move.
      resumeSince: true,
      onevent: (event) => {
        handleOfferRequest({ pool, db, secretKey, swaps, wallet, boltzApiUrl, relay: state.relay }, event).catch((err) => {
          console.error('clink: offer handler crashed:', err)
        })
      },
    })
  }
  openSub()
  console.log(`clink: serving offer '${CLINK_OFFER_ID}' as ${pub.slice(0, 8)}… on ${state.relay}`)

  return {
    snapshot: () => ({ noffer: state.noffer, relay: state.relay }),
    getRelayStatus: () => ({ url: state.relay, connected: pool.listConnectionStatus().get(state.relay) === true }),
    regenerate() {
      sub?.close()
      sub = null
      const next = mint(secretKey, outbox)
      saveNoffer(db, next.noffer)
      state.noffer = next.noffer
      state.relay = next.relay
      openSub()
      console.log(`clink: regenerated offer on ${state.relay}`)
    },
    stop() {
      sub?.close()
      sub = null
    },
  }
}

interface HandlerCtx {
  pool: SimplePool
  db: Database
  secretKey: Uint8Array
  swaps: ArkadeSwaps
  wallet: Wallet
  boltzApiUrl: string
  relay: string
}

/**
 * Sub-dust receive via Boltz's plain-invoice path (server side:
 * patches/boltz-subdust-receive.patch). Boltz issues a plain invoice it
 * collects and, on settlement, sends `amount` to `address` as a plain
 * off-chain vtxo — 1:1, no swap, no swap fee.
 *
 * This drops the reverse swap's atomicity: the external payer settles a real
 * invoice with no on-chain guarantee, trusting Boltz to deliver the vtxo
 * afterward. The counterparty risk is the payer's; it does not depend on who
 * runs the ASP/Boltz. Below dust there is no atomic alternative anyway (the
 * vHTLC claim is impossible), and the amounts are tiny.
 */
async function requestSubdustInvoice(boltzApiUrl: string, amount: number, address: string): Promise<string> {
  const res = await fetch(`${boltzApiUrl}/v2/subdust/receive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount, address }),
  })
  if (!res.ok) {
    throw new Error(`subdust/receive ${res.status}: ${await res.text().catch(() => '')}`)
  }
  const body = (await res.json()) as { invoice?: string }
  if (!body.invoice) throw new Error('subdust/receive: response had no invoice')
  return body.invoice
}

async function handleOfferRequest(ctx: HandlerCtx, event: NostrEvent): Promise<void> {
  // A response to a kind-21001 request reuses kind 21001 with an `e` tag —
  // ignore those so we never answer our own (or a peer's) responses.
  if (event.tags.some((t) => t[0] === 'e')) return

  // Mandatory protocol-disambiguation tag (spec §Protocol Versioning):
  // reject anything not stamped clink_version "1".
  const version = event.tags.find((t) => t[0] === 'clink_version')?.[1]
  if (version !== CLINK_VERSION) {
    console.warn(`clink: ignoring 21001 with clink_version=${version ?? 'none'} from ${event.pubkey.slice(0, 8)}…`)
    return
  }

  let payload: OfferRequestPayload
  try {
    const plaintext = decryptContent(SCHEME, ctx.secretKey, event.pubkey, event.content)
    payload = JSON.parse(plaintext) as OfferRequestPayload
  } catch (err) {
    // Can't decrypt → can't safely reply. Drop.
    console.warn(`clink: failed to decrypt offer request from ${event.pubkey.slice(0, 8)}…:`, err)
    return
  }

  if (payload.offer !== CLINK_OFFER_ID) {
    await respond(ctx, event, { error: 'Invalid Offer', code: ERR_INVALID_OFFER })
    return
  }

  // Spontaneous pricing: the payer MUST name a whole-sat positive amount.
  const amount = payload.amount_sats
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    await respond(ctx, event, { error: 'amount_sats required (positive integer)', code: ERR_INVALID_AMOUNT })
    return
  }

  // NIP-57 zap (payload.zap = a kind-9734 event) is intentionally NOT handled
  // here: a real zap requires minting a descriptionHash invoice (so the 9735
  // receipt verifies) and the @arkade-os/boltz-swap SDK doesn't pass
  // descriptionHash through to Boltz (the backend supports it; the wrapper
  // drops it). Until that lands upstream we don't advertise zap (offer id is
  // not `zap_`-prefixed), so well-behaved payers won't send a zap payload; if
  // one arrives we fall back to a plain spontaneous payment per the spec.
  // TODO(clink-zap): on SDK descriptionHash support → validate the 9734
  // (NIP-57 Appendix D), mint a descriptionHash invoice, publish kind 9735 on
  // settlement, switch the offer id to `zap_default`.

  const description =
    typeof payload.description === 'string' && payload.description.length <= 100
      ? payload.description
      : undefined

  // Sub-dust receive: a Boltz reverse swap can't settle below dust (the vHTLC
  // lockup vtxo is sub-dust → arkd VTXO_RECOVERABLE → claim strands). Fall back
  // to Boltz's non-atomic plain-invoice path: the payer settles a real invoice
  // with no on-chain guarantee, trusting Boltz to deliver the vtxo afterward.
  // There's no swap, so we persist the ack info keyed on the invoice payment
  // hash; reconcileClinkAcks later asks boltz whether it settled and sends the
  // CLINK receipt (with preimage) — see below.
  if (amount < DUST_SATS) {
    let invoice: string
    try {
      const address = await ctx.wallet.getAddress()
      invoice = await requestSubdustInvoice(ctx.boltzApiUrl, amount, address)
    } catch (err) {
      await respond(ctx, event, { error: 'Temporary Failure', code: ERR_TEMPORARY })
      console.error('clink: sub-dust receive failed:', err)
      return
    }
    const paymentHash = decodeInvoice(invoice).paymentHash
    ctx.db
      .query(
        `INSERT INTO clink_subdust_receipts (payment_hash, payer_pubkey, request_id, relay, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(payment_hash) DO NOTHING`,
      )
      .run(paymentHash, event.pubkey, event.id, ctx.relay, Math.floor(Date.now() / 1000))
    await respond(ctx, event, { bolt11: invoice })
    console.log(`clink: issued sub-dust invoice for ${amount} sats to ${event.pubkey.slice(0, 8)}…`)
    return
  }

  let invoice: string
  let swapId: string
  try {
    // ≥dust: a Boltz reverse swap → on payment the SwapManager (boltz.ts)
    // auto-claims the VHTLC into the Ark wallet. Tracked in the swap repo
    // (boltz_swaps), so the ack reconciler can look it up; no transactions row.
    const result = await ctx.swaps.createLightningInvoice({ amount, description })
    invoice = result.invoice
    swapId = result.pendingSwap.id
  } catch (err) {
    if (err instanceof NetworkError) {
      // Boltz rejected — usually amount outside reverse-swap limits. (Range
      // is a SHOULD; populating min/max from Boltz limits is a refinement.)
      const msg = (err.errorData as { error?: string } | undefined)?.error ?? err.message
      await respond(ctx, event, { error: `Invalid Amount: ${msg}`, code: ERR_INVALID_AMOUNT })
      return
    }
    await respond(ctx, event, { error: 'Temporary Failure', code: ERR_TEMPORARY })
    console.error('clink: createLightningInvoice failed:', err)
    return
  }

  // Remember whom to ack once this swap settles (CLINK Payment Receipt).
  // Keyed on swap id; the settlement hook (sendOfferReceipt) consumes it.
  ctx.db
    .query(
      `INSERT INTO clink_offer_receipts (swap_id, payer_pubkey, request_id, relay, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(swap_id) DO NOTHING`,
    )
    .run(swapId, event.pubkey, event.id, ctx.relay, Math.floor(Date.now() / 1000))

  await respond(ctx, event, { bolt11: invoice })
  console.log(`clink: issued invoice for ${amount} sats to ${event.pubkey.slice(0, 8)}…`)
}

interface ReceiptRow {
  payer_pubkey: string
  request_id: string
  relay: string
}

/**
 * Publish the spec's optional CLINK Payment Receipt (kind 21001
 * {res:'ok',preimage}) once an offer-originated reverse swap settles. Wired
 * to boltz's onReverseSettled (see index.ts). Looks the swap up in
 * clink_offer_receipts; if it's not one of ours (e.g. an NWC make_invoice
 * swap) it's a no-op. Best-effort: a down relay means the ack is lost, which
 * is fine — the payer's own wallet already confirmed the LN payment.
 */
/**
 * Publish a CLINK Payment Receipt (kind 21001) to the payer on the relay their
 * request arrived on. Best-effort: a down relay just drops the ack (the payer's
 * own wallet already confirmed the LN payment). With a preimage it's the spec's
 * LN-settled receipt; without, the {res:ok} "internal" form.
 */
async function publishReceipt(
  deps: { pool: SimplePool; secretKey: Uint8Array },
  to: { payer_pubkey: string; request_id: string; relay: string },
  preimage?: string,
): Promise<void> {
  const body = preimage ? { res: 'ok', preimage } : { res: 'ok' }
  const ciphertext = encryptContent(SCHEME, deps.secretKey, to.payer_pubkey, JSON.stringify(body))
  const template: EventTemplate = {
    kind: OFFER_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', to.payer_pubkey],
      ['e', to.request_id],
      ['clink_version', CLINK_VERSION],
    ],
    content: ciphertext,
  }
  const signed = finalizeEvent(template, deps.secretKey)
  const [result] = await Promise.allSettled(deps.pool.publish([to.relay], signed))
  if (result?.status === 'rejected') {
    console.warn(`clink: receipt publish failed on ${to.relay}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
  }
}

export async function sendOfferReceipt(
  deps: { pool: SimplePool; db: Database; secretKey: Uint8Array },
  swap: BoltzReverseSwap,
): Promise<void> {
  const row = deps.db
    .query<ReceiptRow, [string]>(
      'SELECT payer_pubkey, request_id, relay FROM clink_offer_receipts WHERE swap_id = ?',
    )
    .get(swap.id)
  if (!row) return // not an offer swap (or already acked)

  await publishReceipt(deps, row, swap.preimage)
  deps.db.query('DELETE FROM clink_offer_receipts WHERE swap_id = ?').run(swap.id)
  console.log(`clink: sent payment receipt to ${row.payer_pubkey.slice(0, 8)}… for swap ${swap.id.slice(0, 8)}…`)
}

interface SubdustReceiptRow {
  payment_hash: string
  payer_pubkey: string
  request_id: string
  relay: string
  created_at: number
}

// Drop sub-dust pending acks the payer never paid (open invoices that expired or
// were abandoned). The status endpoint only reports `settled`, so age is the
// backstop. Generous so a still-payable invoice is never dropped early.
const SUBDUST_ACK_TTL_SECONDS = 24 * 60 * 60

async function subdustReceiveStatus(
  boltzApiUrl: string,
  paymentHash: string,
): Promise<{ settled: boolean; preimage?: string }> {
  const res = await fetch(`${boltzApiUrl}/v2/subdust/receive/status?paymentHash=${paymentHash}`)
  if (!res.ok) throw new Error(`subdust status ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()) as { settled: boolean; preimage?: string }
}

/**
 * Boot + periodic CLINK ack reconciler — makes acks restart-safe for BOTH
 * directions, since the SDK only fires onReverseSettled live (a swap that
 * settles while the bridge is down never gets its ack otherwise).
 *
 *  - ≥dust (clink_offer_receipts): the swap is in the SDK's boltz_swaps mirror
 *    (re-synced from boltz on boot). Terminal-success → sendOfferReceipt (which
 *    publishes + deletes the row); terminal-failure → just drop the row.
 *  - sub-dust (clink_subdust_receipts): no swap, so ask boltz
 *    (/v2/subdust/receive/status). Settled → publish receipt (+ preimage) and
 *    delete; past TTL → drop.
 *
 * Best-effort and idempotent: rows that the live path already acked are gone, so
 * they're skipped; one row failing doesn't abort the rest.
 */
export async function reconcileClinkAcks(deps: {
  pool: SimplePool
  db: Database
  secretKey: Uint8Array
  boltzApiUrl: string
}): Promise<void> {
  // ≥dust: drive off the small receipts table, PK-lookup boltz_swaps per row.
  const offerRows = deps.db
    .query<{ swap_id: string }, []>('SELECT swap_id FROM clink_offer_receipts')
    .all()
  for (const { swap_id } of offerRows) {
    try {
      const sw = deps.db
        .query<{ status: string; data: string }, [string]>(
          'SELECT status, data FROM boltz_swaps WHERE id = ?',
        )
        .get(swap_id)
      if (!sw || !isReverseFinalStatus(sw.status as BoltzSwapStatus)) continue
      if (isReverseSuccessStatus(sw.status as BoltzSwapStatus)) {
        await sendOfferReceipt(deps, JSON.parse(sw.data) as BoltzReverseSwap)
      } else {
        deps.db.query('DELETE FROM clink_offer_receipts WHERE swap_id = ?').run(swap_id)
      }
    } catch (err) {
      console.warn(`clink: ack reconcile failed for swap ${swap_id.slice(0, 8)}…:`, err)
    }
  }

  // sub-dust: ask boltz whether the invoice settled.
  const now = Math.floor(Date.now() / 1000)
  const subRows = deps.db
    .query<SubdustReceiptRow, []>(
      'SELECT payment_hash, payer_pubkey, request_id, relay, created_at FROM clink_subdust_receipts',
    )
    .all()
  for (const row of subRows) {
    try {
      const status = await subdustReceiveStatus(deps.boltzApiUrl, row.payment_hash)
      if (status.settled) {
        await publishReceipt(deps, row, status.preimage)
        deps.db
          .query('DELETE FROM clink_subdust_receipts WHERE payment_hash = ?')
          .run(row.payment_hash)
        console.log(`clink: sent sub-dust payment receipt to ${row.payer_pubkey.slice(0, 8)}…`)
      } else if (now - row.created_at > SUBDUST_ACK_TTL_SECONDS) {
        deps.db
          .query('DELETE FROM clink_subdust_receipts WHERE payment_hash = ?')
          .run(row.payment_hash)
      }
    } catch (err) {
      // transient (boltz down) — leave the row, retry next pass
      console.warn(`clink: sub-dust ack reconcile failed for ${row.payment_hash.slice(0, 8)}…:`, err)
    }
  }
}

type OfferResponseBody = { bolt11: string } | { error: string; code: number; range?: { min: number; max: number } }

async function respond(ctx: HandlerCtx, request: NostrEvent, body: OfferResponseBody): Promise<void> {
  const ciphertext = encryptContent(SCHEME, ctx.secretKey, request.pubkey, JSON.stringify(body))
  const template: EventTemplate = {
    kind: OFFER_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', request.pubkey],
      ['e', request.id],
      ['clink_version', CLINK_VERSION],
    ],
    content: ciphertext,
  }
  const signed = finalizeEvent(template, ctx.secretKey)
  // Best-effort publish to the noffer's relay (the one the payer listens on
  // for the reply). One failure must not throw.
  const [result] = await Promise.allSettled(ctx.pool.publish([ctx.relay], signed))
  if (result?.status === 'rejected') {
    console.warn(`clink: publish failed on ${ctx.relay}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
  }
}
