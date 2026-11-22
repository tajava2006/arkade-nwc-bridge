import type { Database } from 'bun:sqlite'
import type { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure'
import type { Wallet } from '@arkade-os/sdk'

import { npubEncode } from 'nostr-tools/nip19'

import { CLINK_OFFER_ID } from '../defaults'
import { recordNofferReceive } from '../history'
import { issueInvoice, type IssuedInvoice } from '../ln_receive'
import type { NotifyFn } from '../nostr/notifier'
import { SqliteAtomicSwapRepository, SwapDirection } from '../atomic'
import { decryptContent, encryptContent } from '../nostr/crypto'
import { openPersistentSub, type PersistentSub } from '../nostr/persistent_sub'
import { normalizeRelayUrl, type OutboxWatcher } from '../nostr/outbox'
import type { RelayStatus } from '../lib/relay_status'
import { nofferEncode, nofferDecode, OfferPriceType } from './nip19_offer'
import { validateZapRequest, zapDescriptionHash, publishZapReceipt } from './zap'

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
// NIP-57 zaps: a request may carry a kind-9734 in its `zap` field; we mint a
// descriptionHash invoice for it and publish a 9735 receipt on settlement
// (clink/zap.ts). The optional post-payment CLINK receipt (kind 21001
// {res:ok,preimage}) is sent for every offer swap, zap or not.

const OFFER_KIND = 21001
const CLINK_VERSION = '1'

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
  /** Ark wallet — the receive claims to its address; wallet.identity signs. */
  wallet: Wallet
  /** subdustd's API base; undefined = no Lightning rail (offers answer Temporary Failure). */
  subdustdUrl?: string
  /** ASP (arkd) REST base — the receive's claim needs server params. */
  arkServerUrl: string
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
  const { pool, db, secretKey, outbox, wallet, subdustdUrl, arkServerUrl } = deps
  const pub = getPublicKey(secretKey)

  // Reuse the stored code iff it decodes and was minted under this account
  // key; otherwise (none / corrupt / account changed) mint a fresh one.
  let current: { noffer: string; relay: string } | null = null
  const stored = loadStoredNoffer(db)
  if (stored) {
    try {
      const dec = nofferDecode(stored)
      if (dec.pubkey === pub && dec.offer === CLINK_OFFER_ID) {
        current = { noffer: stored, relay: dec.relay }
      } else if (dec.pubkey !== pub) {
        console.warn('clink: stored noffer pubkey != account key — regenerating')
      } else {
        // Offer id changed under us (e.g. the zap_ prefix switch). The served
        // code must advertise the id the handler actually accepts, so re-mint.
        console.warn(`clink: stored noffer id '${dec.offer}' != '${CLINK_OFFER_ID}' — regenerating`)
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
        handleOfferRequest({ pool, db, secretKey, wallet, subdustdUrl, arkServerUrl, relay: state.relay }, event).catch((err) => {
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
  wallet: Wallet
  subdustdUrl?: string
  arkServerUrl: string
  relay: string
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

  // NIP-57 zap: payload.zap is a stringified kind-9734. Validate it (Appendix
  // D) and, if good, commit SHA256(the exact zap string) into the invoice as a
  // descriptionHash so the kind-9735 receipt we publish on settlement verifies.
  // A present-but-invalid zap is downgraded to a plain payment (logged), never
  // rejected — completing the payment beats blocking it over a receipt. Same
  // for a missing zap on this zap_-prefixed offer (spec: treat as spontaneous).
  const servicePub = getPublicKey(ctx.secretKey)
  let zap: { request: string; descriptionHash: string } | undefined
  if (typeof payload.zap === 'string' && payload.zap.length > 0) {
    const v = validateZapRequest(payload.zap, amount, servicePub)
    if (v.ok) {
      zap = { request: payload.zap, descriptionHash: zapDescriptionHash(payload.zap) }
    } else {
      console.warn(`clink: ignoring invalid zap from ${event.pubkey.slice(0, 8)}… (${v.reason}) — plain payment`)
    }
  }

  const description =
    typeof payload.description === 'string' && payload.description.length <= 100
      ? payload.description
      : undefined

  // issueInvoice (src/ln_receive.ts) is the shared LN-receive core: an atomic
  // receive against subdustd for every amount (D10). There is no swap object
  // to hang the ack on, so it is keyed on the payment hash and the reconcile
  // pass sends it once the swap is settled locally.
  let issued: IssuedInvoice
  try {
    if (!ctx.subdustdUrl) throw new Error('no Lightning rail configured')
    issued = await issueInvoice(
      { wallet: ctx.wallet, subdustdUrl: ctx.subdustdUrl, arkServerUrl: ctx.arkServerUrl, db: ctx.db },
      { amountSats: amount, description, descriptionHash: zap?.descriptionHash },
    )
  } catch (err) {
    // Logged: the payer only ever sees their wallet's own rendering of the
    // error (Zeus turns any failure into "could not connect to the CLINK
    // relay"), so without this line a subdustd-side refusal is invisible here.
    await respond(ctx, event, { error: 'Temporary Failure', code: ERR_TEMPORARY })
    console.error(`clink: ${amount}-sat invoice issue failed:`, err)
    return
  }

  // Persisted before the invoice goes out, so a payment that settles while we
  // are down still gets its receipt (reconcileClinkAcks).
  ctx.db
    .query(
      `INSERT INTO clink_subdust_receipts (payment_hash, payer_pubkey, request_id, relay, zap_request, zap_invoice, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(payment_hash) DO NOTHING`,
    )
    .run(
      issued.paymentHash,
      event.pubkey,
      event.id,
      ctx.relay,
      zap?.request ?? null,
      zap ? issued.invoice : null,
      Math.floor(Date.now() / 1000),
    )

  await respond(ctx, event, { bolt11: issued.invoice })
  console.log(
    `clink: issued invoice for ${amount} sats to ${event.pubkey.slice(0, 8)}…`,
  )
}

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

// Operator-DM line for a CLINK receive. Runs inside the notify thunk, so
// JSON.parse/npubEncode throwing is the notifier's problem, never the ack
// path's. Zaps override payer/amount from the 9734 (its `amount` is msat)
// and carry the comment; plain offer payments fall back to the swap amount.
function describeClinkReceive(
  row: { payer_pubkey: string; zap_request: string | null },
  amountSats: number | undefined,
): string {
  let amount = amountSats
  let comment = ''
  let payer = row.payer_pubkey
  if (row.zap_request) {
    const zap = JSON.parse(row.zap_request) as { pubkey: string; content: string; tags: string[][] }
    payer = zap.pubkey
    const amountTag = zap.tags.find((t) => t[0] === 'amount')?.[1]
    if (amountTag) amount = Math.floor(Number(amountTag) / 1000)
    comment = zap.content
  }
  const who = `${npubEncode(payer).slice(0, 13)}…`
  const what = row.zap_request ? 'zap' : 'noffer payment'
  const note = comment ? ` — "${comment.length > 80 ? `${comment.slice(0, 80)}…` : comment}"` : ''
  return `recv: ${what} ${amount ?? '?'} sats from ${who}${note}`
}

// History-row description for a noffer receive: payer + zap comment when the
// 9734 parses, generic labels otherwise. Never throws — history is display
// bookkeeping and must not endanger the ack path.
function nofferHistoryDescription(row: { payer_pubkey: string; zap_request: string | null }): string {
  try {
    let payer = row.payer_pubkey
    let comment = ''
    if (row.zap_request) {
      const zap = JSON.parse(row.zap_request) as { pubkey: string; content: string }
      payer = zap.pubkey
      comment = zap.content
    }
    const who = `${npubEncode(payer).slice(0, 13)}…`
    const what = row.zap_request ? 'zap' : 'noffer payment'
    return comment ? `${what} from ${who} — "${comment.slice(0, 120)}"` : `${what} from ${who}`
  } catch {
    return row.zap_request ? 'zap' : 'noffer payment'
  }
}

interface PendingReceiptRow {
  payment_hash: string
  payer_pubkey: string
  request_id: string
  relay: string
  // Present only for zap requests: the exact 9734 string + the BOLT11 it was
  // committed into, needed to publish the 9735 receipt on settlement.
  zap_request: string | null
  zap_invoice: string | null
  created_at: number
}

// Drop pending acks the payer never paid (open invoices that expired or were
// abandoned). The status endpoint only reports `settled`, so age is the
// backstop. Generous so a still-payable invoice is never dropped early.
const ACK_TTL_SECONDS = 24 * 60 * 60

/**
 * Boot + periodic CLINK ack reconciler — makes receipts restart-safe: a
 * receive that settles while the bridge is down (or whose live ack was lost)
 * is acked here. Reads the local atomic_swaps row, which
 * reconcileAtomicReceives drives to 'settled' — we already hold the preimage,
 * subdustd is never asked. Settled → publish the receipt (+ preimage, + 9735
 * for zaps) and delete the row; past the TTL → drop it.
 *
 * Best-effort and idempotent: rows the live path already acked are gone, so
 * they're skipped; one row failing doesn't abort the rest.
 */
export async function reconcileClinkAcks(deps: {
  pool: SimplePool
  db: Database
  secretKey: Uint8Array
  notify?: NotifyFn
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const subRows = deps.db
    .query<{ payment_hash: string; created_at: number }, []>(
      'SELECT payment_hash, created_at FROM clink_subdust_receipts',
    )
    .all()
  for (const row of subRows) {
    try {
      const acked = await sendClinkAck(deps, row.payment_hash)
      if (!acked && now - row.created_at > ACK_TTL_SECONDS) {
        deps.db.query('DELETE FROM clink_subdust_receipts WHERE payment_hash = ?').run(row.payment_hash)
      }
    } catch (err) {
      // transient — leave the row, retry next pass
      console.warn(`clink: ack reconcile failed for ${row.payment_hash.slice(0, 8)}…:`, err)
    }
  }
}

/**
 * Publish the CLINK receipt (+9735 for zaps) for ONE settled receive, keyed by
 * payment hash — the single receipt funnel. The reconcile loop above calls it
 * per pending row; a settle detected live (reconcileAtomicReceives' return, or
 * a subdustd ws poke) calls it directly so the ack doesn't wait a tick. The
 * swap must already be `settled` locally (we publish with OUR stored
 * preimage). No-op when there's no pending row (NWC-originated, or already
 * acked) or the swap isn't settled yet. Returns true once the ack went out;
 * the row DELETE is the dedup.
 */
export async function sendClinkAck(
  deps: { pool: SimplePool; db: Database; secretKey: Uint8Array; notify?: NotifyFn },
  paymentHash: string,
): Promise<boolean> {
  const row = deps.db
    .query<PendingReceiptRow, [string]>(
      'SELECT payment_hash, payer_pubkey, request_id, relay, zap_request, zap_invoice, created_at FROM clink_subdust_receipts WHERE payment_hash = ?',
    )
    .get(paymentHash)
  if (!row) return false

  const swap = new SqliteAtomicSwapRepository(deps.db).getByPaymentHash(paymentHash)
  if (swap?.direction !== SwapDirection.Receive || swap.state !== 'settled') return false

  // Ledger row before the publish: a failed publish keeps the receipt row and
  // reruns this funnel, so the (kind, ref) conflict clause absorbs retries —
  // recording after would lose the row if the publish throws. 1:1, no fee.
  try {
    recordNofferReceive(deps.db, {
      ref: row.payment_hash,
      amountSats: swap.amount,
      feesMsat: 0,
      description: nofferHistoryDescription(row),
    })
  } catch (err) {
    console.warn('clink: history record failed (non-fatal):', err)
  }

  deps.notify?.(
    'recv-noffer',
    () => `${describeClinkReceive(row, swap.amount)} [hash ${row.payment_hash.slice(0, 8)}]`,
  )
  await publishReceipt(deps, row, swap.preimage ?? undefined)
  if (row.zap_request && row.zap_invoice) {
    await publishZapReceipt(deps, row.zap_request, row.zap_invoice, swap.preimage ?? undefined)
  }
  deps.db.query('DELETE FROM clink_subdust_receipts WHERE payment_hash = ?').run(row.payment_hash)
  console.log(`clink: sent payment receipt to ${row.payer_pubkey.slice(0, 8)}…`)
  return true
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
