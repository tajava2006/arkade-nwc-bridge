import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import {
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
} from '@arkade-os/sdk'
import { lnDrainInvoiceSat } from '../../src/atomic/fees'
import { openDatabase } from '../../src/db'
import { handlePayInvoice } from '../../src/handlers/pay_invoice'
import { reconcileAtomicSendRows } from '../../src/ln_ledger'
import { sendLightning, type LightningRails } from '../../src/ln_send'
import { createConnection, type Connection } from '../../src/nostr/connections'

// The LN send core on the regtest harness, through the NWC pay_invoice
// handler: since D11 every amount is the atomic send against subdustd — the
// row convention, the coin policy on its funding, a failed payment unwound,
// the crash-window reconcile, and what a too-small wallet gets.
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/ln_send.test.ts

const SUBDUSTD_URL = process.env.SUBDUSTD_URL
const ARKD = process.env.REGTEST_ARKD_URL ?? 'http://localhost:7070'
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'

const sh = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const peer = (...args: string[]): any => JSON.parse(sh('exec', 'lnd-peer', 'lncli', '--network=regtest', ...args))
const sha256 = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 120_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const arkSend = (address: string, amount: number) => {
  const note = sh('exec', 'arkd', 'arkd', 'note', '--amount', String(amount + 1000))
  sh('exec', 'arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
  sh('exec', 'arkd', 'ark', 'send', '--to', address, '--amount', String(amount), '--password', 'secret')
}
const newWallet = () =>
  Wallet.create({
    identity: SingleKey.fromPrivateKey(randomBytes(32)),
    operatorProvider: new RestOperatorProvider(ARKD),
    indexerProvider: new RestIndexerProvider(ARKD),
    onchainProvider: new EsploraProvider(ESPLORA, { forcePolling: true, pollingInterval: 2000 }),
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: false,
  })
const outpoints = async (w: Wallet) => (await w.getSpendableVtxos()).map((v) => `${v.txid}:${v.vout}:${v.value}`)

describe.skipIf(!SUBDUSTD_URL)('LN send core on regtest', () => {
  let wallet: Wallet
  let db: Database
  let conn: Connection
  const lightning: LightningRails = { subdustdUrl: SUBDUSTD_URL! }
  const pay = (eventId: string, invoice: string, w = wallet, d = db, c = conn) =>
    handlePayInvoice({ lightning, db: d, conn: c, eventId, wallet: w, arkServerUrl: ARKD }, { invoice }) as Promise<{
      preimage: string
      fees_paid?: number
    }>
  const row = (eventId: string, d = db) =>
    d
      .query<{ state: string; amount_msat: number; fees_paid_msat: number | null; preimage: string | null }, [string]>(
        `SELECT state, amount_msat, fees_paid_msat, preimage FROM transactions WHERE request_event_id = ?`,
      )
      .get(eventId)!
  const spent = () => db.query<{ s: number }, [number]>('SELECT spent_msat AS s FROM connections WHERE id = ?').get(conn.id)!.s

  beforeAll(async () => {
    wallet = await newWallet()
    const addr = await wallet.getAddress()
    // Two coins: a big one the SDK's own selector would reach for, a small
    // one our policy should spend for a small payment.
    arkSend(addr, 40_000)
    arkSend(addr, 6_000)
    await waitFor('the wallet funded', async () => ((await wallet.getBalance()).available >= 46_000 ? true : undefined))
    db = openDatabase(join(mkdtempSync(join(tmpdir(), 'bridge-lnsend-')), 'bridge.sqlite'))
    conn = createConnection(db, { label: null, relays: ['wss://r'] }).connection
  }, 300_000)

  afterAll(async () => {
    await wallet?.dispose()
  })

  test('dust+ (D11): paid through subdustd; the row is settled by the NWC convention; our coin policy funded it', async () => {
    const big = (await wallet.getSpendableVtxos()).find((v) => v.value === 40_000)!
    const inv = peer('addinvoice', '--amt', '5000')
    const res = await pay('evt-1', inv.payment_request)
    expect(sha256(res.preimage)).toBe(inv.r_hash)
    expect(peer('lookupinvoice', inv.r_hash).state).toBe('SETTLED')
    const r = row('evt-1')
    expect(r.state).toBe('settled')
    expect(r.amount_msat).toBe(5_000_000)
    expect(r.preimage).toBe(res.preimage)
    expect(r.fees_paid_msat).toBe(25_000) // ceil(5,000 × 0.5%)
    expect(res.fees_paid).toBe(25_000)
    // The single covering coin (6000 ≥ 5000 + 25 + dust) is spent, the 40000
    // one untouched — the SDK's own selector takes the largest.
    expect(await outpoints(wallet)).toContain(`${big.txid}:${big.vout}:40000`)
  }, 300_000)

  test('sub-dust: the same atomic send, same row convention', async () => {
    const inv = peer('addinvoice', '--amt', '21')
    const res = await pay('evt-2', inv.payment_request)
    expect(sha256(res.preimage)).toBe(inv.r_hash)
    expect(peer('lookupinvoice', inv.r_hash).state).toBe('SETTLED')
    expect(row('evt-2')).toMatchObject({ state: 'settled', amount_msat: 21_000, preimage: res.preimage })
  }, 300_000)

  test('a failed pay: PAYMENT_FAILED, row failed, the funding back in the wallet', async () => {
    const preimage = randomBytes(32).toString('hex')
    const hash = sha256(preimage)
    const bolt11 = peer('addholdinvoice', hash, '--amt', '5000').payment_request
    const before = (await wallet.getBalance()).available
    const paying = pay('evt-3', bolt11).catch((e) => e)
    await waitFor('the payee to hold the HTLC', () => (peer('lookupinvoice', hash).state === 'ACCEPTED' ? true : undefined))
    peer('cancelinvoice', hash)
    expect(await paying).toMatchObject({ code: 'PAYMENT_FAILED' })
    expect(row('evt-3').state).toBe('failed')
    await waitFor('the funding back in the wallet', async () => ((await wallet.getBalance()).available >= before ? true : undefined))
  }, 300_000)

  test('crash window: a send whose handler never returned is settled by the atomic reconcile', async () => {
    const inv = peer('addinvoice', '--amt', '4000')
    db.query(
      `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, state, created_at)
       VALUES (?, 'outgoing', 'evt-4', ?, ?, 4000000, 'pending', ?)`,
    ).run(conn.id, inv.payment_request, inv.r_hash, Math.floor(Date.now() / 1000))
    const before = spent()
    // The send runs with no handler awaiting it (the process "died" there).
    await sendLightning({ lightning, wallet, arkServerUrl: ARKD, db }, inv.payment_request)
    expect(row('evt-4').state).toBe('pending')
    reconcileAtomicSendRows(db)
    const r = row('evt-4')
    expect(r.state).toBe('settled')
    expect(sha256(r.preimage!)).toBe(inv.r_hash)
    // The crash path books the reserved principal; the atomic row keeps no fee.
    expect(spent() - before).toBe(4_000_000)
  }, 300_000)

  test('Lightning empties the wallet (SM-90); amounts that would strand sub-dust change are refused first', async () => {
    const w = await newWallet()
    arkSend(await w.getAddress(), 3_001)
    await waitFor('funded', async () => ((await w.getBalance()).available >= 3_001 ? true : undefined))
    const dbw = openDatabase(join(mkdtempSync(join(tmpdir(), 'bridge-small-')), 'bridge.sqlite'))
    const connw = createConnection(dbw, { label: null, relays: ['wss://r'] }).connection
    try {
      // 3,000 + 15 fee > 3,001
      const short = await pay('evt-s1', peer('addinvoice', '--amt', '3000').payment_request, w, dbw, connw).catch((e) => e)
      expect(short).toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
      // 2,980 + 15 fee = 2,995 would leave 6 sats: refused, not stranded as sub-dust
      const stranding = await pay('evt-s2', peer('addinvoice', '--amt', '2980').payment_request, w, dbw, connw).catch((e) => e)
      expect(stranding).toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
      expect(row('evt-s2', dbw).state).toBe('failed')
      expect((await w.getSpendableVtxos()).map((v) => v.value)).toEqual([3_001])

      // 2,986 + 15 fee = 3,001: the whole coin funds the swap, the claim has no change output.
      const drain = lnDrainInvoiceSat(3_001, 0.5)
      expect(drain).toBe(2_986)
      const inv = peer('addinvoice', '--amt', String(drain))
      const res = await pay('evt-s3', inv.payment_request, w, dbw, connw)
      expect(sha256(res.preimage)).toBe(inv.r_hash)
      expect(peer('lookupinvoice', inv.r_hash).state).toBe('SETTLED')
      // claimed = the indexer saw the change-less claim spend the shared vtxo (arkd took it)
      const swap = dbw
        .query<{ state: string }, [string]>(`SELECT state FROM atomic_swaps WHERE payment_hash = ?`)
        .get(inv.r_hash)
      expect(swap?.state).toBe('claimed')
      await waitFor('the wallet empty', async () => {
        const b = await w.getBalance()
        return (await w.getSpendableVtxos()).length === 0 && b.available === 0 ? true : undefined
      }, 30_000)
    } finally {
      await w.dispose()
    }
  }, 300_000)
})
