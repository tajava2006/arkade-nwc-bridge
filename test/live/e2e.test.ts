// Tier 3 — end-to-end against real Ark mainnet + NWC relays.
//
// Gated on RUN_LIVE_TESTS=1 because:
//   - it requires network + a valid ARK_NSEC in .env
//   - each run leaves a (free, unpaid) reverse swap record on Boltz
//   - even though no money moves, repeated runs would be rude to upstream
//
// Run with `bun run test:live` after `bun run upgrade` to verify the new
// SDK / boltz-swap / nostr-tools versions actually talk to live services.
//
// Coverage:
//   - real Wallet boot against arkade.computer (catches SDK constructor /
//     wire-protocol breaks)
//   - real ArkadeSwaps + boltz-swap repository wiring (catches swap
//     manager / endpoint breaks)
//   - full NWC round-trip: encrypt → publish → subscribe → decrypt for
//     get_info, get_balance, list_transactions, lookup_invoice (NOT_FOUND),
//     and make_invoice (creates a reverse swap, doesn't pay it)
//
// Excluded on purpose:
//   - pay_invoice: would consume real sats. Manual smoke after upgrade.

import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../../src/config'
import { openDatabase } from '../../src/db'
import { initArkWallet } from '../../src/wallet'
import { initBoltz } from '../../src/boltz'
import { startNostrService, type NostrService } from '../../src/nostr/service'
import { createConnection, revokeConnection } from '../../src/nostr/connections'
import { encryptContent, decryptContent } from '../../src/nostr/crypto'
import { nip19 } from 'nostr-tools'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import { NWCWalletRequest, NWCWalletResponse } from 'nostr-tools/kinds'

const SHOULD_RUN = process.env.RUN_LIVE_TESTS === '1'
const TIMEOUT_MS = 60_000

interface Harness {
  cfg: Config
  dbDir: string
  nostr: NostrService
  swaps: import('@arkade-os/boltz-swap').ArkadeSwaps
  wallet: import('@arkade-os/sdk').Wallet
  clientSecret: Uint8Array
  clientPubkey: string
  servicePubkey: string
  connectionId: number
  pool: SimplePool
  relays: string[]
}

function buildLiveConfig(dbPath: string): Config {
  const arkNsec = process.env.ARK_NSEC
  if (!arkNsec) throw new Error('ARK_NSEC missing — live tests need .env from the repo root')
  const decoded = nip19.decode(arkNsec)
  if (decoded.type !== 'nsec') throw new Error('ARK_NSEC is not an nsec')
  const relays = (process.env.NWC_RELAYS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  if (relays.length === 0) throw new Error('NWC_RELAYS missing')
  return {
    arkNsec,
    arkPrivateKey: decoded.data,
    network: 'bitcoin',
    arkServerUrl: process.env.ARK_SERVER_URL?.trim() || 'https://arkade.computer',
    nwcRelays: relays,
    httpBind: '127.0.0.1',
    httpPort: 0,
    dbPath,
  }
}

/**
 * Build a NIP-47 request event, publish it, and wait for the matching
 * response. Returns the decoded result/error envelope.
 */
async function nwcRequest(
  h: Harness,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  const reqTemplate = {
    kind: NWCWalletRequest,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', h.servicePubkey],
      ['encryption', 'nip44_v2'],
    ],
    content: encryptContent(
      'nip44_v2',
      h.clientSecret,
      h.servicePubkey,
      JSON.stringify({ method, params }),
    ),
  }
  const signed = finalizeEvent(reqTemplate, h.clientSecret)

  // Subscribe *before* publishing — otherwise we'd race a fast response
  // (relays can echo before our subscribe lands). Filter on the response
  // kind, the `p` tag pointing at our client pubkey, and the `e` tag
  // referencing this exact request id.
  const responsePromise = new Promise<
    { result?: unknown; error?: { code: string; message: string } }
  >((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.close()
      reject(new Error(`no response to ${method} within ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    const sub = h.pool.subscribeMany(
      h.relays,
      {
        kinds: [NWCWalletResponse],
        '#p': [h.clientPubkey],
        '#e': [signed.id],
      },
      {
        onevent: (event) => {
          try {
            const plaintext = decryptContent(
              'nip44_v2',
              h.clientSecret,
              h.servicePubkey,
              event.content,
            )
            const parsed = JSON.parse(plaintext)
            clearTimeout(timer)
            sub.close()
            resolve(parsed)
          } catch (err) {
            clearTimeout(timer)
            sub.close()
            reject(err)
          }
        },
      },
    )
  })

  await Promise.allSettled(h.pool.publish(h.relays, signed))
  return responsePromise
}

let harness: Harness | undefined

describe.skipIf(!SHOULD_RUN)('live NWC e2e', () => {
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nwc-bridge-live-'))
    const cfg = buildLiveConfig(join(dir, 'bridge.sqlite'))

    const db = openDatabase(cfg.dbPath)
    const { wallet } = await initArkWallet(cfg)
    const { swaps } = await initBoltz({ db, wallet })
    const nostr = await startNostrService({ cfg, db, wallet, swaps })

    // Mint a temporary connection. revoke happens in afterAll regardless.
    const clientSecret = generateSecretKey()
    const clientPubkey = getPublicKey(clientSecret)
    const created = createConnection(db, {
      label: 'live-test',
      relays: cfg.nwcRelays,
    })
    // The default createConnection generates its own client key — override
    // it for this test so we control the secret on the client side too.
    db.query(`UPDATE connections SET client_pubkey_hex = ? WHERE id = ?`).run(
      clientPubkey,
      created.connection.id,
    )
    const refreshedConn = { ...created.connection, clientPubkeyHex: clientPubkey }
    await nostr.registerConnection(refreshedConn)

    const pool = new SimplePool()

    harness = {
      cfg,
      dbDir: dir,
      nostr,
      swaps,
      wallet,
      clientSecret,
      clientPubkey,
      servicePubkey: created.connection.servicePubkeyHex,
      connectionId: created.connection.id,
      pool,
      relays: cfg.nwcRelays,
    }

    // Hold the db handle on harness via closure — we close it on shutdown.
    ;(harness as Harness & { _db: typeof db })._db = db
  }, 120_000)

  afterAll(async () => {
    if (!harness) return
    const db = (harness as Harness & { _db: import('bun:sqlite').Database })._db
    try {
      revokeConnection(db, harness.connectionId)
      harness.nostr.unregisterConnection(harness.servicePubkey)
      harness.pool.close(harness.relays)
      await harness.nostr.stop()
      await harness.swaps.dispose()
      await harness.wallet.dispose()
    } finally {
      db.close()
      rmSync(harness.dbDir, { recursive: true, force: true })
    }
  }, 60_000)

  test(
    'get_info round-trip',
    async () => {
      const r = await nwcRequest(harness!, 'get_info', {})
      expect(r.error).toBeFalsy()
      const result = r.result as { network: string; methods: string[] }
      expect(result.network).toBe('mainnet')
      expect(result.methods).toContain('pay_invoice')
    },
    TIMEOUT_MS,
  )

  test(
    'get_balance returns a non-negative integer msat balance',
    async () => {
      const r = await nwcRequest(harness!, 'get_balance', {})
      expect(r.error).toBeFalsy()
      const result = r.result as { balance: number }
      expect(typeof result.balance).toBe('number')
      expect(result.balance).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(result.balance)).toBe(true)
    },
    TIMEOUT_MS,
  )

  test(
    'list_transactions on a fresh connection is empty',
    async () => {
      const r = await nwcRequest(harness!, 'list_transactions', {})
      expect(r.error).toBeFalsy()
      const result = r.result as { transactions: unknown[] }
      expect(Array.isArray(result.transactions)).toBe(true)
      expect(result.transactions).toHaveLength(0)
    },
    TIMEOUT_MS,
  )

  test(
    'lookup_invoice with an unknown hash returns NOT_FOUND',
    async () => {
      const r = await nwcRequest(harness!, 'lookup_invoice', {
        payment_hash: 'ff'.repeat(32),
      })
      expect(r.result).toBeNull()
      expect(r.error?.code).toBe('NOT_FOUND')
    },
    TIMEOUT_MS,
  )

  test(
    'make_invoice creates a real reverse swap (kept last; unpaid → free)',
    async () => {
      // Smallest amount that Boltz accepts — keeps the swap cheap to
      // create and trivial to ignore. Don't pay it; it just expires.
      const r = await nwcRequest(harness!, 'make_invoice', { amount: 1_000 })
      expect(r.error).toBeFalsy()
      const result = r.result as {
        type: string
        state: string
        invoice: string
        payment_hash: string
        amount: number
      }
      expect(result.type).toBe('incoming')
      expect(result.state).toBe('pending')
      expect(result.invoice.startsWith('lnbc')).toBe(true)
      expect(result.payment_hash).toMatch(/^[0-9a-f]{64}$/)
      // Boltz reverse-swap fee can be more than the requested amount for
      // very small invoices, in which case the on-Ark received amount
      // could be 0 or negative. We don't assert the exact value — just
      // that the field is a number and the row exists.
      expect(typeof result.amount).toBe('number')
    },
    TIMEOUT_MS * 2,
  )
})

