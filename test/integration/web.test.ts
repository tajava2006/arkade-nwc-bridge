import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { nip19 } from 'nostr-tools'
import type { Config } from '../../src/config'
import { createAccount } from '../../src/account'
import { startWebServer, type AppStateRef, type WebServer } from '../../src/web/server'
import type { NostrService } from '../../src/nostr/service'
import type { OfferService } from '../../src/clink/offers'
import type { OutboxWatcher } from '../../src/nostr/outbox'
import { SseHub } from '../../src/lib/sse'
import type { ArkadeSwaps } from '@arkade-os/boltz-swap'
import { openTempDb, type TempDb } from '../helpers/db'
import type { ProofSyncService } from '../../src/exit/sync_service'
import type { ExitEngine } from '../../src/exit/engine'
import {
  getProofPsbts,
  getVaultVtxo,
  quarantineVtxo,
  storeVtxoWithProofs,
} from '../../src/exit/vault'
import { ChainTxType } from '@arkade-os/sdk'
import {
  emptyBalance,
  makeArkProviderStub,
  makeSwapsStub,
  makeSwrCaches,
  makeWalletStub,
} from '../helpers/mocks'

// Bun.serve binds to a real port. Use 0 to ask the OS for any free one so
// concurrent test files don't collide.
const STUB_NOSTR: NostrService = {
  registerConnection: async () => {},
  unregisterConnection: () => {},
  getRelayStatus: (urls) => urls.map((url) => ({ url, connected: false })),
  stop: async () => {},
}

// Shared pool isn't exercised by these web tests (only /send's CLINK resolve
// uses it). A bare cast is enough to satisfy the ready-state shape.
// Readiness tile reads snapshot(); web tests never run a real sync pass.
const STUB_EXIT_ENGINE: ExitEngine = {
  startExit: () => {},
  sweep: async () => {
    throw new Error('stub')
  },
  resume: () => {},
  feeRate: async () => 2,
  explorer: async () => {
    throw new Error('stub')
  },
  fundingStatus: async () => ({ address: 'bc1pstubfunding', balanceSat: 5_000 }),
  stepBoostInfo: async () => null,
  boostStep: async () => {
    throw new Error('stub')
  },
  sweepBoostInfo: async () => null,
  boostSweep: async () => {
    throw new Error('stub')
  },
  destStatus: () => null,
  issueDest: () => ({ ok: false, reason: 'stub' }),
  verifyDest: () => ({ ok: false, reason: 'stub' }),
  clearDest: () => {},
  exitSummary: () => ({ total: 0, swept: 0, unresolved: 0 }),
  finalSend: async () => {
    throw new Error('stub')
  },
  finalSendInfo: async () => null,
  boostFinalSend: async () => {
    throw new Error('stub')
  },
  snapshot: () => ({ ops: [], active: null }),
  onUpdate: () => () => {},
  stop: () => {},
}

const STUB_PROOF_SYNC: ProofSyncService = {
  trigger: () => {},
  snapshot: () => ({
    stats: {
      vtxoCount: 0,
      readyCount: 0,
      quarantinedCount: 0,
      expiredCount: 0,
      proofTxCount: 0,
      proofBytes: 0,
      lastSyncedAt: null,
      soonestExpiresAt: null,
    },
    claim: null,
    lastRun: null,
    running: false,
  }),
  onUpdate: () => () => {},
  stop: () => {},
}

const STUB_POOL = {} as unknown as import('nostr-tools/pool').SimplePool

const STUB_OFFERS: OfferService = {
  snapshot: () => ({ noffer: 'noffer1stub', relay: 'wss://r' }),
  getRelayStatus: () => ({ url: 'wss://r', connected: false }),
  regenerate: () => {},
  stop: () => {},
}

const STUB_OUTBOX: OutboxWatcher = {
  getOutboxRelays: () => ['wss://r'],
  getOutboxSource: () => 'operator',
  isResolved: () => true,
  setPrimaryPubkey: () => {},
  getBootstrapRelayStatus: () => [],
  getOutboxRelayStatus: () => [{ url: 'wss://r', connected: false }],
  onOutboxChange: () => () => {},
  stop: async () => {},
}

const CFG: Config = {
  network: 'bitcoin',
  arkServerUrl: 'https://stub',
  boltzApiUrl: 'https://stub',
  esploraUrls: ['https://stub-esplora'],
  httpBind: '127.0.0.1',
  httpPort: 0,
  dbPath: '',
}

// Pre-built ready-mode AppState so the web server skips the /setup gate.
// The setup flow itself has its own test below.
function readyState(): AppStateRef {
  const balance = emptyBalance({ available: 1234, recoverable: 0 })
  const wallet = makeWalletStub({ balance, address: 'tark1stubaddress' })
  return {
    current: {
      mode: 'ready',
      arkServerUrl: 'https://stub',
      boltzApiUrl: 'https://stub',
      wallet,
      swaps: makeSwapsStub() as ArkadeSwaps,
      nostr: STUB_NOSTR,
      offers: STUB_OFFERS,
      pool: STUB_POOL,
      caches: makeSwrCaches(wallet, balance),
      arkAddress: 'tark1stubaddress',
      boardingAddress: 'bc1qstubboarding',
      onboardingFeeProgram: '1000.0',
      arkProvider: makeArkProviderStub(),
      proofSync: STUB_PROOF_SYNC,
      exitEngine: STUB_EXIT_ENGINE,
    },
  }
}

describe('web server', () => {
  let temp: TempDb
  let web: WebServer
  let base: string

  beforeAll(async () => {
    temp = openTempDb()
    web = startWebServer({
      cfg: CFG,
      db: temp.db,
      state: readyState(),
      sseHub: new SseHub(),
      outbox: STUB_OUTBOX,
      bootReady: async () => {},
    })
    base = web.url
  })

  afterAll(async () => {
    await web.stop()
    temp.cleanup()
  })

  test('dashboard renders with balance and connection count', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('Dashboard')
    expect(body).toContain('tark1stubaddress')
    expect(body).toContain('1,234') // available sats from stub
  })

  test('connections list (empty)', async () => {
    const res = await fetch(`${base}/connections`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Connections')
  })

  test('new-connection form', async () => {
    const res = await fetch(`${base}/connections/new`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<form')
    expect(body.toLowerCase()).toContain('label')
  })

  test('the nsec is never served after setup — /settings is gone', async () => {
    // Deterministic, valid (non-zero, < n) secp256k1 key for stable assertions.
    const sk = new Uint8Array(32).fill(7)
    createAccount(temp.db, sk)
    // The settings page used to render npub + nsec; the browser is the least
    // trusted surface, so the route was removed (backup path: show-nsec script).
    expect((await fetch(`${base}/settings`)).status).toBe(404)
    for (const path of ['/', '/connections']) {
      const body = await (await fetch(`${base}${path}`)).text()
      expect(body).not.toContain(nip19.nsecEncode(sk))
    }
  })

  test('connection detail returns 404 for nonexistent id', async () => {
    const res = await fetch(`${base}/connections/9999`)
    expect(res.status).toBe(404)
  })

  test('unknown route is 404', async () => {
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
  })

  test('POST /connections/new creates a connection and renders the URI/QR', async () => {
    const form = new FormData()
    form.set('label', 'test-client')
    const res = await fetch(`${base}/connections/new`, { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('nostr+walletconnect://')
    expect(body).toContain('<svg') // QR rendered inline

    // And the row exists with the label we passed.
    const row = temp.db
      .query<{ label: string }, []>(`SELECT label FROM connections ORDER BY id DESC LIMIT 1`)
      .get()
    expect(row?.label).toBe('test-client')
  })

  test('POST /connections/new rejects bad budget input with 400', async () => {
    const form = new FormData()
    form.set('budget_sats', 'twelve')
    const res = await fetch(`${base}/connections/new`, { method: 'POST', body: form })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('budget')
  })

  test('POST /connections/new rejects an unknown budget renewal with 400', async () => {
    const form = new FormData()
    form.set('budget_sats', '1000')
    form.set('budget_renewal', 'hourly')
    const res = await fetch(`${base}/connections/new`, { method: 'POST', body: form })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('renewal')
  })

  test('POST /connections/new persists the chosen renewal; unlimited forces never', async () => {
    const form = new FormData()
    form.set('budget_sats', '1000')
    form.set('budget_renewal', 'weekly')
    let res = await fetch(`${base}/connections/new`, { method: 'POST', body: form })
    expect(res.status).toBe(200)
    let row = temp.db
      .query<{ budget_renewal: string }, []>(
        `SELECT budget_renewal FROM connections ORDER BY id DESC LIMIT 1`,
      )
      .get()
    expect(row?.budget_renewal).toBe('weekly')

    // no budget → the renewal select is ignored, stored as 'never'
    const unlimited = new FormData()
    unlimited.set('budget_renewal', 'daily')
    res = await fetch(`${base}/connections/new`, { method: 'POST', body: unlimited })
    expect(res.status).toBe(200)
    row = temp.db
      .query<{ budget_renewal: string }, []>(
        `SELECT budget_renewal FROM connections ORDER BY id DESC LIMIT 1`,
      )
      .get()
    expect(row?.budget_renewal).toBe('never')
  })

  test('list and detail render the renewal + window spend', async () => {
    const form = new FormData()
    form.set('label', 'renewal-render')
    form.set('budget_sats', '1000')
    form.set('budget_renewal', 'weekly')
    await fetch(`${base}/connections/new`, { method: 'POST', body: form })
    const row = temp.db
      .query<{ id: number }, []>(`SELECT id FROM connections ORDER BY id DESC LIMIT 1`)
      .get()

    const list = await (await fetch(`${base}/connections`)).text()
    expect(list).toContain('0 / 1,000 sats · weekly')

    const detail = await (await fetch(`${base}/connections/${row?.id}`)).text()
    expect(detail).toContain('0 / 1,000 sats · weekly')
    expect(detail).toContain('Budget resets')
  })

  test('GET /send renders the form + breakdown', async () => {
    const res = await fetch(`${base}/send`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Send')
    expect(body).toContain('data-send-form')
    expect(body).toContain('Balance breakdown')
    // Consolidate-all Refresh is commented out (647bf09, arkd expiry-gap
    // gating — arkade-os/arkd#1119); restore this assertion together with
    // the send.ts UI block and the /refresh route.
    // expect(body).toContain('Refresh all')
  })

  test('POST /send (review) with empty destination is 400', async () => {
    const form = new FormData()
    form.set('destination', '')
    const res = await fetch(`${base}/send`, { method: 'POST', body: form })
    expect(res.status).toBe(400)
  })

  test('POST /send (review) onchain max with no funds is 400 (below dust)', async () => {
    const form = new FormData()
    form.set('destination', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    form.set('max', '1')
    const res = await fetch(`${base}/send`, { method: 'POST', body: form })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body.toLowerCase()).toContain('dust')
  })

  test('POST /send (review) onchain with amount shows the breakdown, no row yet', async () => {
    const form = new FormData()
    form.set('destination', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    form.set('amount', '5000')
    const res = await fetch(`${base}/send`, { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Recipient receives')
    expect(body).toContain('Total leaving wallet')
    expect(body).toContain('Confirm')
    expect(body).toContain('/send/confirm')

    // Review must not move funds: no offboard row written.
    const count = temp.db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM offboards`).get()
    expect(count?.c).toBe(0)
  })

  test('POST /send (review) lightning shows amount + fee + total', async () => {
    const invoice =
      'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'
    const form = new FormData()
    form.set('destination', invoice)
    const res = await fetch(`${base}/send`, { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Lightning payment')
    expect(body).toContain('Swap fee')
    expect(body).toContain('Total leaving wallet')
  })

  test('POST /send/confirm onchain records a pending offboard and acks', async () => {
    const form = new FormData()
    form.set('destination', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    form.set('amount', '5000')
    const res = await fetch(`${base}/send/confirm`, { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Offboard submitted')

    const row = temp.db
      .query<{ address: string; amount_sat: number }, []>(
        `SELECT address, amount_sat FROM offboards ORDER BY id DESC LIMIT 1`,
      )
      .get()
    expect(row?.address).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    expect(row?.amount_sat).toBe(5000) // recipient-net; fee 0 under empty intent-fee program
  })

  // Skipped as the pair of the /refresh route disable (647bf09) — the route
  // 404s on purpose until arkd lets a near-expiry input anchor a mixed-expiry
  // intent (arkade-os/arkd#1119). Re-enable together with the route.
  test.skip('POST /refresh acks immediately (fire-and-forget)', async () => {
    const res = await fetch(`${base}/refresh`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Refresh submitted')
  })
})

describe('web server — setup mode', () => {
  let temp: TempDb
  let web: WebServer
  let base: string
  let bootedWith: Uint8Array | null = null

  beforeAll(() => {
    temp = openTempDb()
    const state: AppStateRef = { current: { mode: 'setup' } }
    web = startWebServer({
      cfg: CFG,
      db: temp.db,
      state,
      sseHub: new SseHub(),
      outbox: STUB_OUTBOX,
      // Stub the server probe so /setup doesn't make real network calls to the
      // default (mainnet) URLs during tests. Rejection is covered separately.
      validateServer: async () => ({ ok: true }),
      bootReady: async (pk) => {
        // Don't actually bring up wallet/boltz/nostr in tests — just record
        // the key the route handed us and flip mode like index.ts would.
        bootedWith = pk
        const wallet = makeWalletStub({ address: 'tark1stub' })
        state.current = {
          mode: 'ready',
          arkServerUrl: 'https://stub',
          boltzApiUrl: 'https://stub',
          wallet,
          swaps: makeSwapsStub() as ArkadeSwaps,
          nostr: STUB_NOSTR,
          offers: STUB_OFFERS,
          pool: STUB_POOL,
          caches: makeSwrCaches(wallet, emptyBalance()),
          arkAddress: 'tark1stub',
          boardingAddress: 'bc1qstubboarding',
          onboardingFeeProgram: '1000.0',
          arkProvider: makeArkProviderStub(),
          proofSync: STUB_PROOF_SYNC,
          exitEngine: STUB_EXIT_ENGINE,
        }
      },
    })
    base = web.url
  })

  afterAll(async () => {
    await web.stop()
    temp.cleanup()
  })

  test('non-setup routes redirect to /setup before an account exists', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/setup')
  })

  test('GET /setup renders the form', async () => {
    const res = await fetch(`${base}/setup`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Ark server URL')
    expect(body).toContain('Boltz API URL')
    expect(body).toContain('Generate new nsec')
  })

  test('POST /setup with bogus nsec returns the form with an error', async () => {
    const form = new FormData()
    form.set('mode', 'paste')
    form.set('nsec', 'not-an-nsec')
    const res = await fetch(`${base}/setup`, { method: 'POST', body: form })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('Could not parse nsec')
    // No account row should have been written for a parse failure.
    const row = temp.db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM accounts').get()
    expect(row?.c).toBe(0)
  })

  test('POST /setup with a valid generated key flips to ready mode', async () => {
    const form = new FormData()
    form.set('mode', 'generate')
    const res = await fetch(`${base}/setup`, { method: 'POST', body: form, redirect: 'manual' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('nsec1') // generated nsec is shown on success page
    expect(bootedWith).not.toBeNull()
    expect(bootedWith!.length).toBe(32)

    // Account row exists, and GET / now serves the dashboard instead of redirecting.
    const accountRow = temp.db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM accounts').get()
    expect(accountRow?.c).toBe(1)
    // the fresh-start server row was written alongside the account (defaults,
    // since the form left the URL fields blank)
    const serverRow = temp.db
      .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM bridge_server')
      .get()
    expect(serverRow?.c).toBe(1)
    const dashRes = await fetch(`${base}/`)
    expect(dashRes.status).toBe(200)
    const dashBody = await dashRes.text()
    expect(dashBody).toContain('Dashboard')
  })

  test('GET /setup once configured redirects to /', async () => {
    const res = await fetch(`${base}/setup`, { redirect: 'manual' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
  })
})

// The server choice is immutable once it sticks (change = drain + fresh
// sqlite), so /setup must persist NOTHING unless the set validates AND the
// wallet actually comes up. Both halves are covered here with an injected
// validator / bootReady so no real network is touched.
describe('web server — setup validation & rollback', () => {
  test('a rejected server set returns 400 and persists nothing', async () => {
    const temp = openTempDb()
    const state: AppStateRef = { current: { mode: 'setup' } }
    const web = startWebServer({
      cfg: CFG,
      db: temp.db,
      state,
      sseHub: new SseHub(),
      outbox: STUB_OUTBOX,
      validateServer: async () => ({ ok: false, reason: 'Ark server reports network regtest' }),
      bootReady: async () => {
        throw new Error('bootReady must not run when validation fails')
      },
    })
    try {
      const form = new FormData()
      form.set('mode', 'generate')
      const res = await fetch(`${web.url}/setup`, { method: 'POST', body: form })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('reports network regtest')
      const accounts = temp.db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM accounts').get()
      const servers = temp.db
        .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM bridge_server')
        .get()
      expect(accounts?.c).toBe(0)
      expect(servers?.c).toBe(0)
      expect(state.current.mode).toBe('setup')
    } finally {
      await web.stop()
      temp.cleanup()
    }
  })

  test('a failed bring-up rolls back BOTH the account and the server row', async () => {
    const temp = openTempDb()
    const state: AppStateRef = { current: { mode: 'setup' } }
    const web = startWebServer({
      cfg: CFG,
      db: temp.db,
      state,
      sseHub: new SseHub(),
      outbox: STUB_OUTBOX,
      validateServer: async () => ({ ok: true }),
      bootReady: async () => {
        throw new Error('ASP unreachable')
      },
    })
    try {
      const form = new FormData()
      form.set('mode', 'generate')
      const res = await fetch(`${web.url}/setup`, { method: 'POST', body: form })
      expect(res.status).toBe(500)
      expect(await res.text()).toContain('failed to start the wallet')
      const accounts = temp.db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM accounts').get()
      const servers = temp.db
        .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM bridge_server')
        .get()
      expect(accounts?.c).toBe(0)
      expect(servers?.c).toBe(0)
      expect(state.current.mode).toBe('setup')
    } finally {
      await web.stop()
      temp.cleanup()
    }
  })
})

describe('web server — degraded mode', () => {
  let temp: TempDb
  let web: WebServer
  let base: string

  beforeAll(() => {
    temp = openTempDb()
    // one exit-ready vtxo in the vault — the page must render it from
    // sqlite alone (no wallet object exists in this mode)
    storeVtxoWithProofs(
      temp.db,
      {
        txid: 'a'.repeat(64),
        vout: 0,
        source: 'wallet',
        valueSat: 1000,
        script: '5120' + 'ab'.repeat(32),
        tapTree: 'c0de',
        status: 'preconfirmed',
        expiresAt: null,
        chain: [
          {
            txid: 'a'.repeat(64),
            type: ChainTxType.ARK,
            expiresAt: '',
            spends: ['c'.repeat(64)],
          },
          { txid: 'c'.repeat(64), type: ChainTxType.COMMITMENT, expiresAt: '', spends: [] },
        ],
      },
      [{ txid: 'a'.repeat(64), type: ChainTxType.ARK, psbtB64: 'psbt' }],
    )
    const state: AppStateRef = {
      current: {
        mode: 'degraded',
        error: 'getInfo: ConnectionRefused',
        since: Math.floor(Date.now() / 1000) - 120,
        attempts: 3,
        onchainAddress: 'bc1pstubfunding',
        exitEngine: STUB_EXIT_ENGINE,
      },
    }
    web = startWebServer({
      cfg: CFG,
      db: temp.db,
      state,
      sseHub: new SseHub(),
      outbox: STUB_OUTBOX,
      bootReady: async () => {},
    })
    base = web.url
  })

  afterAll(async () => {
    await web.stop()
    temp.cleanup()
  })

  test('/ renders the degraded status page from local data only', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('unreachable')
    expect(body).toContain('getInfo: ConnectionRefused')
    expect(body).toContain('bc1pstubfunding')
    expect(body).toContain('1/1 vtxos exit-ready')
  })

  test('ready-only routes bounce to the status page', async () => {
    for (const path of ['/send', '/connections']) {
      const res = await fetch(`${base}${path}`, { redirect: 'manual' })
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/')
    }
  })

  test('/setup bounces to / — the account already exists', async () => {
    const res = await fetch(`${base}/setup`, { redirect: 'manual' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
  })

  test('/exit renders from the vault with the ASP dead', async () => {
    const res = await fetch(`${base}/exit`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Degraded mode')
    expect(body).toContain('one vtxo at a time')
    expect(body).toContain('1,000 sats') // the seeded vault vtxo
    expect(body).toContain('exit cost')
  })

  test('/exit carries the final-send section; route wiring rejects a stub issue', async () => {
    const res = await fetch(`${base}/exit`)
    const body = await res.text()
    expect(body).toContain('Final send')
    expect(body).toContain('show-btc-key')
    // stub engine refuses to issue → the error page, not a 500
    const post = await fetch(`${base}/exit/dest`, {
      method: 'POST',
      body: new URLSearchParams({ address: 'bc1qqq' }),
    })
    expect(post.status).toBe(400)
    expect(await post.text()).toContain('Challenge failed')
  })

  test('/exit/:txid/:vout renders DB-only and arms the client probe loop', async () => {
    // the stub engine's explorer() throws, so a 200 here proves the page
    // render never touched esplora — statuses are the fill-in loop's job
    const res = await fetch(`${base}/exit/${'a'.repeat(64)}/0`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`data-step="${'a'.repeat(64)}"`)
    expect(body).toContain('data-probe-note')
    expect(body).toContain(`/exit/${'a'.repeat(64)}/0/step/`)
    expect(body).toContain('not broadcast yet')
  })

  test('step endpoint answers 503 when no esplora resolves', async () => {
    const res = await fetch(`${base}/exit/${'a'.repeat(64)}/0/step/${'a'.repeat(64)}`)
    expect(res.status).toBe(503)
  })
})

describe('web server — exit step endpoint', () => {
  const TXID = 'a'.repeat(64)
  let temp: TempDb
  let web: WebServer
  let base: string

  beforeAll(() => {
    temp = openTempDb()
    storeVtxoWithProofs(
      temp.db,
      {
        txid: TXID,
        vout: 0,
        valueSat: 1000,
        source: 'wallet',
        script: '5120' + 'ab'.repeat(32),
        tapTree: 'c0de',
        status: 'preconfirmed',
        expiresAt: null,
        chain: [
          { txid: TXID, type: ChainTxType.ARK, expiresAt: '', spends: ['c'.repeat(64)] },
          { txid: 'c'.repeat(64), type: ChainTxType.COMMITMENT, expiresAt: '', spends: [] },
        ],
      },
      [{ txid: TXID, type: ChainTxType.ARK, psbtB64: 'psbt' }],
    )
    // explorer that has seen nothing — every probe answers "not broadcast"
    const explorer = {
      getTxStatus: async () => {
        throw new Error('not found')
      },
      getChainTip: async () => ({ height: 100, time: 60_000, hash: 'h' }),
    }
    const state: AppStateRef = {
      current: {
        mode: 'degraded',
        error: 'getInfo: ConnectionRefused',
        since: Math.floor(Date.now() / 1000) - 120,
        attempts: 3,
        onchainAddress: 'bc1pstubfunding',
        exitEngine: {
          ...STUB_EXIT_ENGINE,
          explorer: async () => explorer as unknown as Awaited<ReturnType<ExitEngine['explorer']>>,
        },
      },
    }
    web = startWebServer({
      cfg: CFG,
      db: temp.db,
      state,
      sseHub: new SseHub(),
      outbox: STUB_OUTBOX,
      bootReady: async () => {},
    })
    base = web.url
  })

  afterAll(async () => {
    await web.stop()
    temp.cleanup()
  })

  test('serves the probed step as status + rendered li', async () => {
    const res = await fetch(`${base}/exit/${TXID}/0/step/${TXID}`)
    expect(res.status).toBe(200)
    const d = (await res.json()) as { status: string; stepHtml: string; waitHtml?: string }
    expect(d.status).toBe('pending')
    expect(d.stepHtml).toContain(`data-step="${TXID}"`)
    expect(d.stepHtml).toContain('not broadcast yet')
    expect(d.waitHtml).toBeUndefined()
  })

  test('404 for txids outside the vtxo chain (no open esplora proxy)', async () => {
    const res = await fetch(`${base}/exit/${TXID}/0/step/${'b'.repeat(64)}`)
    expect(res.status).toBe(404)
    // commitment entries are metadata, not probeable steps
    const res2 = await fetch(`${base}/exit/${TXID}/0/step/${'c'.repeat(64)}`)
    expect(res2.status).toBe(404)
  })
})

describe('web server — exit forget', () => {
  const TXID = 'd'.repeat(64)
  let temp: TempDb
  let web: WebServer
  let base: string

  const seedRow = (): void => {
    storeVtxoWithProofs(
      temp.db,
      {
        txid: TXID,
        vout: 0,
        valueSat: 1000,
        source: 'wallet',
        script: '5120' + 'ab'.repeat(32),
        tapTree: 'c0de',
        status: 'preconfirmed',
        expiresAt: null,
        chain: [
          { txid: TXID, type: ChainTxType.ARK, expiresAt: '', spends: ['c'.repeat(64)] },
          { txid: 'c'.repeat(64), type: ChainTxType.COMMITMENT, expiresAt: '', spends: [] },
        ],
      },
      [{ txid: TXID, type: ChainTxType.ARK, psbtB64: 'psbt' }],
    )
  }

  beforeAll(() => {
    temp = openTempDb()
    seedRow()
    const state: AppStateRef = {
      current: {
        mode: 'degraded',
        error: 'getInfo: ConnectionRefused',
        since: Math.floor(Date.now() / 1000) - 120,
        attempts: 3,
        onchainAddress: 'bc1pstubfunding',
        exitEngine: STUB_EXIT_ENGINE,
      },
    }
    web = startWebServer({
      cfg: CFG,
      db: temp.db,
      state,
      sseHub: new SseHub(),
      outbox: STUB_OUTBOX,
      bootReady: async () => {},
    })
    base = web.url
  })

  afterAll(async () => {
    await web.stop()
    temp.cleanup()
  })

  test('404 when the vtxo is not in the vault', async () => {
    const res = await fetch(`${base}/exit/${'e'.repeat(64)}/0/forget`, {
      method: 'POST',
      redirect: 'manual',
    })
    expect(res.status).toBe(404)
  })

  test('409 on a live (non-quarantined) row — a misclick must not shred proofs', async () => {
    const res = await fetch(`${base}/exit/${TXID}/0/forget`, {
      method: 'POST',
      redirect: 'manual',
    })
    expect(res.status).toBe(409)
    expect(getVaultVtxo(temp.db, TXID, 0)).not.toBeNull()
    expect(getProofPsbts(temp.db, [TXID]).size).toBe(1)
  })

  test('quarantined row: deletes it and its orphaned proofs, bounces to /exit', async () => {
    quarantineVtxo(temp.db, TXID, 0, 'test quarantine')
    const res = await fetch(`${base}/exit/${TXID}/0/forget`, {
      method: 'POST',
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('/exit')
    expect(getVaultVtxo(temp.db, TXID, 0)).toBeNull()
    expect(getProofPsbts(temp.db, [TXID]).size).toBe(0)
    seedRow() // restore for any later test in this block
  })
})
