import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config'
import { startWebServer, type AppStateRef, type WebServer } from '../../src/web/server'
import type { NostrService } from '../../src/nostr/service'
import type { OfferService } from '../../src/clink/offers'
import type { OutboxWatcher } from '../../src/nostr/outbox'
import { SseHub } from '../../src/lib/sse'
import type { ArkadeSwaps } from '@arkade-os/boltz-swap'
import { openTempDb, type TempDb } from '../helpers/db'
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
const STUB_POOL = {} as unknown as import('nostr-tools/pool').SimplePool

const STUB_OFFERS: OfferService = {
  snapshot: () => ({ noffer: 'noffer1stub', relay: 'wss://r' }),
  getRelayStatus: () => ({ url: 'wss://r', connected: false }),
  regenerate: () => {},
  stop: () => {},
}

const STUB_OUTBOX: OutboxWatcher = {
  getOutboxRelays: () => ['wss://r'],
  isResolved: () => false,
  getBootstrapRelayStatus: () => [],
  getOutboxRelayStatus: () => [{ url: 'wss://r', connected: false }],
  onOutboxChange: () => () => {},
  stop: async () => {},
}

const CFG: Config = {
  network: 'bitcoin',
  arkServerUrl: 'https://stub',
  boltzApiUrl: 'https://stub',
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

  test('history page renders empty list without crashing', async () => {
    const res = await fetch(`${base}/history`)
    expect(res.status).toBe(200)
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

  test('GET /send renders the form + breakdown', async () => {
    const res = await fetch(`${base}/send`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Send')
    expect(body).toContain('data-send-form')
    expect(body).toContain('Balance breakdown')
    expect(body).toContain('Refresh all')
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

  test('POST /refresh acks immediately (fire-and-forget)', async () => {
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
      bootReady: async (pk) => {
        // Don't actually bring up wallet/boltz/nostr in tests — just record
        // the key the route handed us and flip mode like index.ts would.
        bootedWith = pk
        const wallet = makeWalletStub({ address: 'tark1stub' })
        state.current = {
          mode: 'ready',
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
    expect(body).toContain('Paste an existing nsec')
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
