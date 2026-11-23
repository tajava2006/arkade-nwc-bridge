import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { decryptContent, encryptContent } from '../../src/nostr/crypto'

// SM-53: the real bridge process on the regtest-solver harness, driven the way
// a nostr client drives it — NIP-47 over the harness relay — plus the web
// pages SM-46 changed. Lightning comes from data/config.json's `lightning`
// block (subdustd, every amount — D11); `nostrRelays` keeps the bridge off
// every public relay.
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/bridge_nwc.test.ts

const ARKD = process.env.REGTEST_ARKD_URL ?? 'http://localhost:7070'
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'
const SUBDUSTD_URL = process.env.SUBDUSTD_URL
const RELAY = process.env.REGTEST_NOSTR_RELAY ?? 'ws://localhost:7777'
const PORT = 4300 + Math.floor(Math.random() * 600)
const BASE = `http://127.0.0.1:${PORT}`
const BRIDGE = resolve(import.meta.dir, '../..')

const sh = (container: string, ...args: string[]) =>
  execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const peer = (...a: string[]): any => JSON.parse(sh('lnd-peer', 'lncli', '--network=regtest', ...a))
const sha256 = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 120_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    let v: T | undefined
    try {
      v = await fn()
    } catch {
      v = undefined
    }
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const form = async (path: string, fields: Record<string, string>) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { origin: BASE }, body: new URLSearchParams(fields), redirect: 'manual' })
const page = async (path: string) => (await fetch(`${BASE}${path}`)).text()
const payers: ChildProcess[] = []
const peerPays = (bolt11: string) =>
  payers.push(spawn('docker', ['exec', 'lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', bolt11], { stdio: 'ignore' }))

describe.skipIf(!SUBDUSTD_URL)('the bridge process over NWC on regtest', () => {
  let bridge: ChildProcess
  let logPath: string
  const pool = new SimplePool()
  const clientSecret = { sk: new Uint8Array(32), pub: '' }
  let service = ''

  /** One NIP-47 request: kind 23194 (nip44) → the bridge's kind 23195 answer. */
  const nwc = async (method: string, params: Record<string, unknown> = {}, timeoutMs = 240_000): Promise<{ result?: any; error?: { code: string; message: string } }> => {
    const req = finalizeEvent(
      {
        kind: 23194,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', service],
          ['encryption', 'nip44_v2'],
        ],
        content: encryptContent('nip44_v2', clientSecret.sk, service, JSON.stringify({ method, params })),
      },
      clientSecret.sk,
    )
    const answer = new Promise<NostrEvent>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`no answer to ${method}`)), timeoutMs)
      const sub = pool.subscribeMany([RELAY], { kinds: [23195], '#e': [req.id] }, {
        onevent: (e) => {
          clearTimeout(timer)
          sub.close()
          res(e)
        },
      })
    })
    await Bun.sleep(300) // the subscription must be live before the request lands
    await Promise.allSettled(pool.publish([RELAY], req))
    const e = await answer
    return JSON.parse(decryptContent('nip44_v2', clientSecret.sk, service, e.content))
  }

  beforeAll(async () => {
    const runtime = mkdtempSync(join(tmpdir(), 'bridge-nwc-'))
    mkdirSync(join(runtime, 'data'))
    writeFileSync(
      join(runtime, 'data', 'config.json'),
      JSON.stringify({
        network: 'regtest',
        arkServerUrl: ARKD,
        esploraUrls: [ESPLORA],
        httpPort: PORT,
        dbPath: './data/bridge.sqlite',
        nostrRelays: [RELAY],
        lightning: { subdustdUrl: SUBDUSTD_URL },
      }),
    )
    logPath = join(runtime, 'bridge.log')
    const out = openSync(logPath, 'w')
    bridge = spawn('bun', ['run', join(BRIDGE, 'src/index.ts')], { cwd: runtime, stdio: ['ignore', out, out] })
    await waitFor('the bridge web server', async () => ((await fetch(`${BASE}/setup`)).status === 200 ? true : undefined), 90_000)

    // /setup with a key we hold, so the test can fund its Ark address.
    const sk = randomBytes(32)
    const r = await form('/setup', { mode: 'paste', nsec: sk.toString('hex'), server_choice: 'hoppe' })
    expect([200, 303]).toContain(r.status)
    await waitFor('ready mode', async () => ((await page('/')).includes('Dashboard') ? true : undefined), 120_000)

    const created = await (await form('/connections/new', { label: 'drill' })).text()
    const uri = created.match(/nostr\+walletconnect:\/\/[^"'<\s]+/)![0].replace(/&amp;/g, '&')
    const u = new URL(uri.replace('nostr+walletconnect://', 'http://'))
    service = u.hostname
    clientSecret.sk = Uint8Array.from(Buffer.from(u.searchParams.get('secret')!, 'hex'))
    clientSecret.pub = getPublicKey(clientSecret.sk)
    expect(u.searchParams.getAll('relay').map((x) => x.replace(/\/$/, ''))).toEqual([RELAY.replace(/\/$/, '')])

    // Fund the bridge wallet: two coins, as a user would hold them.
    const ark = (await page('/')).match(/tark1[02-9ac-hj-np-z]{50,}/)![0]
    for (const amount of [20_000, 6_000]) {
      const note = sh('arkd', 'arkd', 'note', '--amount', String(amount + 1000))
      sh('arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
      sh('arkd', 'ark', 'send', '--to', ark, '--amount', String(amount), '--password', 'secret')
    }
    await waitFor('the wallet funded', async () => {
      const b = await nwc('get_balance', {}, 15_000)
      return b.result?.balance >= 26_000_000 ? true : undefined
    }, 120_000)
  }, 400_000)

  afterAll(async () => {
    for (const p of payers) p.kill()
    bridge?.kill('SIGTERM')
    pool.close([RELAY])
    await Bun.sleep(500)
  })

  test('get_info advertises the LN methods', async () => {
    const r = await nwc('get_info')
    expect(r.result.methods).toEqual(expect.arrayContaining(['pay_invoice', 'make_invoice', 'lookup_invoice', 'list_transactions', 'get_balance']))
  }, 60_000)

  test('pay_invoice ≥ dust (subdustd, D11): preimage of the invoice, amount = nominal, fees_paid = 0.5%', async () => {
    const inv = peer('addinvoice', '--amt', '5000')
    const r = await nwc('pay_invoice', { invoice: inv.payment_request })
    expect(r.error ?? null).toBeNull() // NIP-47 answers carry error: null beside the result
    expect(sha256(r.result.preimage)).toBe(inv.r_hash)
    const l = await nwc('lookup_invoice', { payment_hash: inv.r_hash })
    expect(l.result).toMatchObject({ type: 'outgoing', state: 'settled', amount: 5_000_000, preimage: r.result.preimage })
    expect(r.result.fees_paid).toBe(25_000)
    expect(l.result.fees_paid).toBe(25_000)
  }, 300_000)

  test('pay_invoice < dust (subdustd): a 21-sat invoice is paid atomically', async () => {
    const inv = peer('addinvoice', '--amt', '21')
    const r = await nwc('pay_invoice', { invoice: inv.payment_request })
    expect(r.error ?? null).toBeNull() // NIP-47 answers carry error: null beside the result
    expect(sha256(r.result.preimage)).toBe(inv.r_hash)
    expect((await nwc('lookup_invoice', { payment_hash: inv.r_hash })).result).toMatchObject({ state: 'settled', amount: 21_000 })
  }, 300_000)

  test('pay_invoice that fails: PAYMENT_FAILED, the row failed, the money back', async () => {
    const preimage = randomBytes(32).toString('hex')
    const hash = sha256(preimage)
    const bolt11 = peer('addholdinvoice', hash, '--amt', '4000').payment_request
    const before = (await nwc('get_balance')).result.balance
    const paying = nwc('pay_invoice', { invoice: bolt11 })
    await waitFor('the payee to hold the HTLC', () => (peer('lookupinvoice', hash).state === 'ACCEPTED' ? true : undefined))
    peer('cancelinvoice', hash)
    const r = await paying
    expect(r.error?.code).toBe('PAYMENT_FAILED')
    expect((await nwc('lookup_invoice', { payment_hash: hash })).result.state).toBe('failed')
    await waitFor('the refund in the balance', async () => ((await nwc('get_balance')).result.balance >= before ? true : undefined))
  }, 300_000)

  test('make_invoice ≥ dust (subdustd, D10): description kept, paid → settled with our preimage, no fee', async () => {
    const r = await nwc('make_invoice', { amount: 5_000_000, description: 'tea' })
    expect(r.result).toMatchObject({ type: 'incoming', state: 'pending', amount: 5_000_000, description: 'tea' })
    expect(peer('decodepayreq', r.result.invoice)).toMatchObject({ num_satoshis: '5000', description: 'tea' })
    peerPays(r.result.invoice)
    const l = await waitFor('settled', async () => {
      const x = (await nwc('lookup_invoice', { payment_hash: r.result.payment_hash }, 15_000)).result
      return x?.state === 'settled' ? x : undefined
    }, 180_000)
    expect(sha256(l.preimage)).toBe(r.result.payment_hash)
    expect(l.fees_paid ?? 0).toBe(0)
  }, 300_000)

  test('make_invoice for a 21-sat zap: the invoice reads 21 with the description hash alone', async () => {
    const descriptionHash = sha256('cd'.repeat(40))
    const r = await nwc('make_invoice', { amount: 21_000, description_hash: descriptionHash })
    expect(r.result.amount).toBe(21_000)
    expect(peer('decodepayreq', r.result.invoice)).toMatchObject({ num_satoshis: '21', description_hash: descriptionHash, description: '' })
    peerPays(r.result.invoice)
    await waitFor('settled', async () => ((await nwc('lookup_invoice', { payment_hash: r.result.payment_hash }, 15_000)).result?.state === 'settled' ? true : undefined), 180_000)
  }, 300_000)

  test('list_transactions: settled rows by default, the failed one only with unpaid', async () => {
    const states = async (params: Record<string, unknown>) =>
      ((await nwc('list_transactions', params)).result.transactions as { type: string; state: string }[]).map((t) => `${t.type}:${t.state}`)
    const settled = await states({ limit: 50 })
    expect(settled.filter((s) => s === 'outgoing:settled')).toHaveLength(2)
    expect(settled.filter((s) => s === 'incoming:settled')).toHaveLength(2)
    expect(settled).not.toContain('outgoing:failed')
    expect(await states({ limit: 50, unpaid: true })).toContain('outgoing:failed')
  }, 60_000)

  test('web pages: the send preview prices from subdustd, /swaps lists the atomic swaps, the dashboard says no receive fee', async () => {
    const inv = peer('addinvoice', '--amt', '3000')
    const preview = await (await form('/send', { destination: inv.payment_request })).text()
    expect(preview).toContain('Lightning payment')
    expect(preview).toContain('Total leaving wallet')
    expect(preview).toContain('15 sats (0.5%, routing included)')
    expect(preview).toContain('3,015 sats')
    const swaps = await page('/swaps')
    expect(swaps).toContain('Atomic swaps')
    expect(swaps).not.toContain('Solver')
    expect(await page('/')).toContain('Fee: none')
    // and the process never reached for a public relay
    expect(readFileSync(logPath, 'utf8')).not.toMatch(/wss:\/\//)
  }, 120_000)
})
