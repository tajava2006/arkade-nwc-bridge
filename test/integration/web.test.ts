import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config'
import { startWebServer, type WebServer } from '../../src/web/server'
import type { NostrService } from '../../src/nostr/service'
import { openTempDb, type TempDb } from '../helpers/db'
import { emptyBalance, makeWalletStub } from '../helpers/mocks'

// Bun.serve binds to a real port. Use 0 to ask the OS for any free one so
// concurrent test files don't collide.
const STUB_NOSTR: NostrService = {
  registerConnection: async () => {},
  unregisterConnection: () => {},
  stop: async () => {},
}

const CFG: Config = {
  arkNsec: '',
  arkPrivateKey: new Uint8Array(),
  network: 'bitcoin',
  arkServerUrl: 'https://stub',
  nwcRelays: ['wss://r'],
  httpBind: '127.0.0.1',
  httpPort: 0,
  dbPath: '',
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
      wallet: makeWalletStub({
        balance: emptyBalance({ available: 1234, recoverable: 0 }),
        address: 'tark1stubaddress',
      }),
      arkAddress: 'tark1stubaddress',
      nostr: STUB_NOSTR,
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
})
