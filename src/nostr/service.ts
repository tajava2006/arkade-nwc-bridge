import type { Database } from 'bun:sqlite'
import type { Wallet } from '@arkade-os/sdk'
import type { ArkadeSwaps } from '@arkade-os/boltz-swap'
import { SimplePool } from 'nostr-tools/pool'
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

const SUPPORTED_METHODS = ['get_info', 'get_balance', 'make_invoice', 'pay_invoice'] as const
type SupportedMethod = (typeof SUPPORTED_METHODS)[number]

interface NwcRequest {
  method: string
  params: Record<string, unknown>
}

export interface NostrServiceDeps {
  cfg: Config
  db: Database
  wallet: Wallet
  swaps: ArkadeSwaps
}

export interface NostrService {
  stop(): Promise<void>
}

export async function startNostrService(deps: NostrServiceDeps): Promise<NostrService> {
  const { cfg, db, wallet } = deps
  const pool = new SimplePool()

  // Publish a fresh info event per active connection. kind 13194 is
  // replaceable, so re-publishing on every boot just overwrites the prior
  // version. If there are no connections yet, this is a no-op.
  const connections = listActiveConnections(db)
  if (connections.length === 0) {
    console.log('nostr: no active connections — run `bun run scripts/new-connection.ts` to issue one')
  }
  for (const conn of connections) {
    await publishInfoEvent(pool, cfg.nwcRelays, conn)
  }
  console.log(
    `nostr: ${connections.length} active connection${connections.length === 1 ? '' : 's'}; ` +
      `subscribing to ${cfg.nwcRelays.length} relay${cfg.nwcRelays.length === 1 ? '' : 's'}`,
  )

  const servicePubkeys = connections.map((c) => c.servicePubkeyHex)
  const sub =
    servicePubkeys.length > 0
      ? pool.subscribeMany(
          cfg.nwcRelays,
          {
            kinds: [NWCWalletRequest],
            '#p': servicePubkeys,
            // Only events newer than service start — old events would have been
            // delivered already on previous runs (or never within their expiration).
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
      : null

  return {
    async stop() {
      sub?.close()
      pool.close(cfg.nwcRelays)
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
  await Promise.all(pool.publish(relays, signed))
}

async function handleEvent(
  deps: NostrServiceDeps,
  pool: SimplePool,
  event: NostrEvent,
): Promise<void> {
  const { cfg, db, wallet } = deps

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
      await respondError(pool, cfg.nwcRelays, conn, event, 'nip04', 'unknown', err)
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
    await respondOk(pool, cfg.nwcRelays, conn, event, scheme, method, result)
  } catch (err) {
    const nwcErr =
      err instanceof NwcError
        ? err
        : new NwcError('INTERNAL', err instanceof Error ? err.message : String(err))
    await respondError(pool, cfg.nwcRelays, conn, event, scheme, method, nwcErr)
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
  await Promise.all(pool.publish(relays, signed))
}
