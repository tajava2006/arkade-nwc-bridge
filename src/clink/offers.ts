import type { Database } from 'bun:sqlite'
import type { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure'
import { NetworkError, type ArkadeSwaps } from '@arkade-os/boltz-swap'

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
  const { pool, db, secretKey, outbox, swaps } = deps
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
        handleOfferRequest({ pool, secretKey, swaps, relay: state.relay }, event).catch((err) => {
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
  secretKey: Uint8Array
  swaps: ArkadeSwaps
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

  const description =
    typeof payload.description === 'string' && payload.description.length <= 100
      ? payload.description
      : undefined

  let invoice: string
  try {
    // Same path as NWC make_invoice: Boltz reverse swap → on payment the
    // SwapManager (boltz.ts) auto-claims the VHTLC into the Ark wallet. The
    // swap is tracked in the swap repo, so it settles without a bridge
    // transactions row; it just won't appear in NWC connection history.
    const result = await ctx.swaps.createLightningInvoice({ amount, description })
    invoice = result.invoice
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

  await respond(ctx, event, { bolt11: invoice })
  console.log(`clink: issued invoice for ${amount} sats to ${event.pubkey.slice(0, 8)}…`)
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
