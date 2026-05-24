import type { Database } from 'bun:sqlite'
import type { Wallet } from '@arkade-os/sdk'
import type { ArkadeSwaps } from '@arkade-os/boltz-swap'
import type { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, type EventTemplate, type NostrEvent } from 'nostr-tools/pure'
import { NWCWalletInfo, NWCWalletRequest, NWCWalletResponse } from 'nostr-tools/kinds'

import type { Config } from '../config'
import { NwcError } from '../lib/errors'
import {
  findConnectionByServicePubkey,
  isEventProcessed,
  listActiveConnections,
  markEventProcessed,
  serviceSecretBytes,
  type Connection,
} from './connections'
import { decryptContent, encryptContent, pickRequestScheme, type EncryptionScheme } from './crypto'
import { handleGetInfo } from '../handlers/get_info'
import { handleGetBalance } from '../handlers/get_balance'
import { handleMakeInvoice } from '../handlers/make_invoice'
import { handlePayInvoice } from '../handlers/pay_invoice'
import { handleLookupInvoice } from '../handlers/lookup_invoice'
import { handleListTransactions } from '../handlers/list_transactions'
import { SUPPORTED_METHODS, type SupportedMethod } from '../lib/methods'
import type { RelayStatus } from '../lib/relay_status'

interface NwcRequest {
  method: string
  params: Record<string, unknown>
}

export interface NostrServiceDeps {
  cfg: Config
  db: Database
  wallet: Wallet
  swaps: ArkadeSwaps
  /**
   * Shared SimplePool. Same instance the outbox watcher uses — so every
   * subsystem reads listConnectionStatus from one place and the UI
   * stays consistent across the outbox panel and connection rows.
   */
  pool: SimplePool
}

export interface NostrService {
  /**
   * Publishes the info event for this connection and starts listening for
   * its NWC requests, without waiting for the next boot. Called by the
   * web layer right after createConnection inserts the DB row.
   */
  registerConnection(conn: Connection): Promise<void>
  /**
   * Stops listening for requests on this service pubkey. Existing requests
   * already in-flight finish on their own. The info event is left on the
   * relay (replaceable; it'll be naturally overwritten if the pubkey is
   * ever reused, otherwise it just expires when the relay sweeps idle
   * events). NIP-09 kind-5 deletion is not published — relays vary in how
   * they honor it, and a stale info event with no service listening is
   * harmless because every request from the client gets dropped at the
   * authorization step anyway.
   */
  unregisterConnection(servicePubkeyHex: string): void
  /**
   * Connection status for the given URLs — used by the web layer to
   * render per-connection relay badges. Returns one entry per input URL
   * in the same order; relays the pool has never seen come back as
   * `connected: false`.
   */
  getRelayStatus(urls: readonly string[]): RelayStatus[]
  stop(): Promise<void>
}

export async function startNostrService(deps: NostrServiceDeps): Promise<NostrService> {
  const { db, pool } = deps

  // One SubCloser per connection. A single multi-pubkey filter would also
  // work, but keeping subs per-connection means we can close just one on
  // revoke without rebuilding the others — no race window where a request
  // arrives while we're between unsubscribe and resubscribe.
  const subs = new Map<string, ReturnType<SimplePool['subscribeMany']>>()

  const subscribeOne = (conn: Connection): void => {
    if (subs.has(conn.servicePubkeyHex)) return
    if (conn.relays.length === 0) {
      console.warn(`nostr: conn #${conn.id} has no relays — skipping subscribe`)
      return
    }
    const sub = pool.subscribeMany(
      conn.relays,
      {
        kinds: [NWCWalletRequest],
        '#p': [conn.servicePubkeyHex],
        // Only events newer than the moment we subscribed. For the boot
        // path that's start-of-service; for registerConnection that's
        // creation time. Either way, anything older is either a stale
        // replay (handled by processed_events) or expired by now.
        since: Math.floor(Date.now() / 1000),
      },
      {
        onevent: (event) => {
          handleEvent(deps, pool, event).catch((err) => {
            console.error('nostr: handler crashed:', err)
          })
        },
      },
    )
    subs.set(conn.servicePubkeyHex, sub)
  }

  const connections = listActiveConnections(db)
  if (connections.length === 0) {
    console.log(
      'nostr: no active connections — create one at /connections/new',
    )
  }
  for (const conn of connections) {
    if (conn.relays.length === 0) {
      console.warn(`nostr: conn #${conn.id} has no relays — skipping`)
      continue
    }
    await publishInfoEvent(pool, conn.relays, conn)
    subscribeOne(conn)
  }
  console.log(
    `nostr: ${connections.length} active connection${connections.length === 1 ? '' : 's'}`,
  )

  return {
    async registerConnection(conn) {
      if (conn.relays.length === 0) {
        throw new Error('refusing to register a connection with no relays')
      }
      await publishInfoEvent(pool, conn.relays, conn)
      subscribeOne(conn)
    },
    unregisterConnection(servicePubkeyHex) {
      const sub = subs.get(servicePubkeyHex)
      if (!sub) return
      sub.close()
      subs.delete(servicePubkeyHex)
    },
    getRelayStatus(urls) {
      const live = pool.listConnectionStatus()
      return urls.map((url) => ({ url, connected: live.get(url) === true }))
    },
    async stop() {
      for (const sub of subs.values()) sub.close()
      subs.clear()
      // Pool is owned by the caller (index.ts) — leave its sockets to
      // the outbox watcher / shutdown sequence.
    },
  }
}

async function publishInfoEvent(
  pool: SimplePool,
  relays: string[],
  conn: Connection,
): Promise<void> {
  const template: EventTemplate = {
    kind: NWCWalletInfo,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['encryption', 'nip44_v2 nip04']],
    content: SUPPORTED_METHODS.join(' '),
  }
  const signed = finalizeEvent(template, serviceSecretBytes(conn))
  await publishToRelays(pool, relays, signed, `info event (conn #${conn.id})`)
}

/**
 * Publish to every relay, but never let a single relay's timeout/rejection
 * tank the caller. nostr-tools' SimplePool returns one promise per relay
 * and pool.publish() resolves them independently — Promise.all would
 * reject as soon as any relay fails, which on boot crashes the bridge
 * before it ever finishes subscribing.
 *
 * Treat publishing as best-effort: log per-relay failures, succeed as
 * long as we tried. NIP-47 info events are replaceable, so even if every
 * relay rejects we'll retry on next boot anyway.
 */
async function publishToRelays(
  pool: SimplePool,
  relays: string[],
  signed: NostrEvent,
  context: string,
): Promise<void> {
  const results = await Promise.allSettled(pool.publish(relays, signed))
  const failures = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{ relay: relays[i] ?? '?', reason: r.reason }] : [],
  )
  if (failures.length > 0) {
    for (const f of failures) {
      console.warn(
        `nostr: publish failed for ${context} on ${f.relay}: ${
          f.reason instanceof Error ? f.reason.message : String(f.reason)
        }`,
      )
    }
  }
}

async function handleEvent(
  deps: NostrServiceDeps,
  pool: SimplePool,
  event: NostrEvent,
): Promise<void> {
  const { db } = deps

  // Which connection does this request target?
  const pTag = event.tags.find((t) => t[0] === 'p')
  const servicePubkey = pTag?.[1]
  if (!servicePubkey) {
    return // not addressed to any specific service pubkey — ignore
  }
  const conn = findConnectionByServicePubkey(db, servicePubkey)
  if (!conn) return // no live connection for this pubkey

  // Replay protection — skip if we already responded to this event id.
  if (isEventProcessed(db, event.id)) return

  // Author must match the connection's client pubkey. Without this, anyone
  // who knew the service pubkey could send requests; the secret in the URI
  // is what proves they own the connection.
  if (event.pubkey !== conn.clientPubkeyHex) {
    console.warn(`nostr: ignored event from unauthorized pubkey ${event.pubkey} on conn #${conn.id}`)
    return
  }

  // Expiration tag — NIP-47 says: if expiration has passed, ignore the request.
  const expirationTag = event.tags.find((t) => t[0] === 'expiration')
  if (expirationTag?.[1]) {
    const expiresAt = Number.parseInt(expirationTag[1], 10)
    if (Number.isFinite(expiresAt) && expiresAt < Math.floor(Date.now() / 1000)) {
      markEventProcessed(db, { eventId: event.id, connectionId: conn.id, method: 'expired' })
      return
    }
  }

  let scheme: EncryptionScheme
  try {
    scheme = pickRequestScheme(event.tags)
  } catch (err) {
    if (err instanceof NwcError) {
      await respondError(pool, conn.relays, conn, event, 'nip04', 'unknown', err)
      markEventProcessed(db, { eventId: event.id, connectionId: conn.id, method: 'unknown' })
    }
    return
  }

  let request: NwcRequest
  try {
    const plaintext = decryptContent(scheme, serviceSecretBytes(conn), event.pubkey, event.content)
    request = JSON.parse(plaintext) as NwcRequest
  } catch (err) {
    console.warn(`nostr: failed to decrypt/parse request on conn #${conn.id}:`, err)
    // We can't safely respond if decryption failed (would require the same
    // scheme that we couldn't read).
    return
  }

  const method = request.method
  console.log(`nostr: conn #${conn.id} → ${method}`)

  try {
    const result = await dispatch(deps, conn, event, method, request.params)
    await respondOk(pool, conn.relays, conn, event, scheme, method, result)
  } catch (err) {
    const nwcErr =
      err instanceof NwcError
        ? err
        : new NwcError('INTERNAL', err instanceof Error ? err.message : String(err))
    await respondError(pool, conn.relays, conn, event, scheme, method, nwcErr)
    console.error(`nostr: conn #${conn.id} ${method} failed:`, err)
  } finally {
    markEventProcessed(db, { eventId: event.id, connectionId: conn.id, method })
  }
}

async function dispatch(
  deps: NostrServiceDeps,
  conn: Connection,
  event: NostrEvent,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method as SupportedMethod) {
    case 'get_info':
      return handleGetInfo({ cfg: deps.cfg })
    case 'get_balance':
      return handleGetBalance({ wallet: deps.wallet })
    case 'make_invoice':
      return handleMakeInvoice(
        { swaps: deps.swaps, db: deps.db, conn, eventId: event.id },
        params,
      )
    case 'pay_invoice':
      return handlePayInvoice(
        { swaps: deps.swaps, db: deps.db, conn, eventId: event.id },
        params,
      )
    case 'lookup_invoice':
      return handleLookupInvoice({ db: deps.db, conn }, params)
    case 'list_transactions':
      return handleListTransactions({ db: deps.db, conn }, params)
    default:
      throw new NwcError('NOT_IMPLEMENTED', `unknown method '${method}'`)
  }
}

async function respondOk(
  pool: SimplePool,
  relays: string[],
  conn: Connection,
  request: NostrEvent,
  scheme: EncryptionScheme,
  method: string,
  result: unknown,
): Promise<void> {
  await sendResponse(pool, relays, conn, request, scheme, {
    result_type: method,
    error: null,
    result,
  })
}

async function respondError(
  pool: SimplePool,
  relays: string[],
  conn: Connection,
  request: NostrEvent,
  scheme: EncryptionScheme,
  method: string,
  err: NwcError,
): Promise<void> {
  await sendResponse(pool, relays, conn, request, scheme, {
    result_type: method,
    error: { code: err.code, message: err.message },
    result: null,
  })
}

async function sendResponse(
  pool: SimplePool,
  relays: string[],
  conn: Connection,
  request: NostrEvent,
  scheme: EncryptionScheme,
  body: unknown,
): Promise<void> {
  const ciphertext = encryptContent(
    scheme,
    serviceSecretBytes(conn),
    request.pubkey,
    JSON.stringify(body),
  )
  const template: EventTemplate = {
    kind: NWCWalletResponse,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', request.pubkey],
      ['e', request.id],
    ],
    content: ciphertext,
  }
  const signed = finalizeEvent(template, serviceSecretBytes(conn))
  await publishToRelays(pool, relays, signed, `response to event ${request.id}`)
}
