import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import {
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
} from '@arkade-os/sdk'
import { openDatabase } from '../../src/db'
import { handlePayInvoice } from '../../src/handlers/pay_invoice'
import { watchSolverSends } from '../../src/ln_ledger'
import type { LightningRails } from '../../src/ln_send'
import { createConnection, type Connection } from '../../src/nostr/connections'
import { startSolverRail } from '../../src/solver_rail'

// The LN send core (SM-43) on the regtest-solver harness, through the NWC
// pay_invoice handler: the solver rail for dust and up, subdustd below, the
// ledger listener, and the coin policy on the swap client's funding.
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/ln_send.test.ts

const SOLVER_URL = process.env.SOLVER_URL
const CARD_PATH = process.env.SOLVER_CARD_PATH
const EMU = process.env.EMULATOR_PUBKEY_OVERRIDE
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

describe.skipIf(!SOLVER_URL || !CARD_PATH || !EMU || !SUBDUSTD_URL)('LN send core on regtest', () => {
  let wallet: Wallet
  let db: Database
  let conn: Connection
  let lightning: LightningRails
  let stopLedger: () => void
  const arkInfo = () => new RestArkProvider(ARKD).getInfo()
  const solverConfig = () => ({
    solverUrl: SOLVER_URL!,
    solverCard: JSON.parse(readFileSync(CARD_PATH!, 'utf8')),
    subdustdUrl: SUBDUSTD_URL!,
    emulatorPubkey: EMU!,
  })
  const pay = (eventId: string, invoice: string) =>
    handlePayInvoice({ lightning, db, conn, eventId, wallet, arkServerUrl: ARKD }, { invoice }) as Promise<{
      preimage: string
      fees_paid?: number
    }>
  const row = (eventId: string) =>
    db
      .query<{ state: string; amount_msat: number; fees_paid_msat: number | null; preimage: string | null; swap_id: string | null }, [string]>(
        `SELECT state, amount_msat, fees_paid_msat, preimage, swap_id FROM transactions WHERE request_event_id = ?`,
      )
      .get(eventId)!

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
    const solver = await startSolverRail({ wallet, db, lightning: solverConfig(), network: 'regtest', arkInfo })
    lightning = { solver, subdustdUrl: SUBDUSTD_URL! }
    stopLedger = watchSolverSends({ lightning, arkServerUrl: ARKD, db })
  }, 300_000)

  afterAll(async () => {
    stopLedger?.()
    await lightning?.solver.dispose()
    await wallet?.dispose()
  })

  test('≥ dust: paid through the solver; the row is settled by the NWC convention; our coin policy funded it', async () => {
    const big = (await wallet.getSpendableVtxos()).find((v) => v.value === 40_000)!
    const inv = peer('addinvoice', '--amt', '5000')
    const res = await pay('evt-1', inv.payment_request)
    expect(sha256(res.preimage)).toBe(inv.r_hash)
    expect(peer('lookupinvoice', inv.r_hash).state).toBe('SETTLED')
    const r = row('evt-1')
    expect(r.state).toBe('settled')
    expect(r.amount_msat).toBe(5_000_000)
    expect(r.preimage).toBe(res.preimage)
    expect(r.swap_id).toMatch(/^rfq:/)
    expect(r.fees_paid_msat ?? 0).toBe(res.fees_paid ?? 0)
    // The single covering coin (6000) is spent, the 40000 one untouched — the
    // SDK's own selector takes the largest.
    expect(await outpoints(wallet)).toContain(`${big.txid}:${big.vout}:40000`)
  }, 300_000)

  test('sub-dust: the atomic send against subdustd, same row convention', async () => {
    const inv = peer('addinvoice', '--amt', '21')
    const res = await pay('evt-2', inv.payment_request)
    expect(sha256(res.preimage)).toBe(inv.r_hash)
    expect(peer('lookupinvoice', inv.r_hash).state).toBe('SETTLED')
    expect(row('evt-2')).toMatchObject({ state: 'settled', amount_msat: 21_000, preimage: res.preimage })
  }, 300_000)

  test('a failed pay: PAYMENT_FAILED, row failed, the lockup back in the wallet', async () => {
    const preimage = randomBytes(32).toString('hex')
    const hash = sha256(preimage)
    const bolt11 = peer('addholdinvoice', hash, '--amt', '5000').payment_request
    const before = (await wallet.getBalance()).available
    const paying = pay('evt-3', bolt11).catch((e) => e)
    await waitFor('the payee to hold the HTLC', () => (peer('lookupinvoice', hash).state === 'ACCEPTED' ? true : undefined))
    peer('cancelinvoice', hash)
    expect(await paying).toMatchObject({ code: 'PAYMENT_FAILED' })
    expect(row('evt-3').state).toBe('failed')
    await waitFor('the refund back in the wallet', async () => ((await wallet.getBalance()).available >= before ? true : undefined))
  }, 300_000)

  test('restart replay: a send whose handler never returned is settled by the ledger listener', async () => {
    // The handler's pending row, unlinked (a crash before onSwapCreated), and
    // the swap driven to `paid` with no handler awaiting it.
    const inv = peer('addinvoice', '--amt', '4000')
    db.query(
      `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, state, created_at)
       VALUES (?, 'outgoing', 'evt-4', ?, ?, 4000000, 'pending', ?)`,
    ).run(conn.id, inv.payment_request, inv.r_hash, Math.floor(Date.now() / 1000))
    stopLedger()
    const res = await lightning.solver.client.pay(inv.payment_request)
    const id = res.kind === 'swap' ? res.swap.id : ''
    await waitFor('paid', async () => ((await lightning.solver.client.swaps()).find((s) => s.id === id)?.outcome === 'paid' ? true : undefined))
    expect(row('evt-4').state).toBe('pending')
    const spentBefore = db.query<{ s: number }, [number]>('SELECT spent_msat AS s FROM connections WHERE id = ?').get(conn.id)!.s
    // Re-subscribing replays every known swap, as a boot does.
    stopLedger = watchSolverSends({ lightning, arkServerUrl: ARKD, db })
    await waitFor('the replay to settle the row', () => (row('evt-4').state === 'settled' ? true : undefined), 30_000)
    const r = row('evt-4')
    expect(sha256(r.preimage!)).toBe(inv.r_hash)
    expect(r.swap_id).toBe(id)
    const spentAfter = db.query<{ s: number }, [number]>('SELECT spent_msat AS s FROM connections WHERE id = ?').get(conn.id)!.s
    expect(spentAfter - spentBefore).toBe(4_000_000 + (r.fees_paid_msat ?? 0))
  }, 300_000)

  test('drain: a residue under the slack is not refused; it stays ours as recoverable sub-dust', async () => {
    const w = await newWallet()
    arkSend(await w.getAddress(), 3_001)
    await waitFor('funded', async () => ((await w.getBalance()).available >= 3_001 ? true : undefined))
    const dbw = openDatabase(join(mkdtempSync(join(tmpdir(), 'bridge-drain-')), 'bridge.sqlite'))
    const connw = createConnection(dbw, { label: null, relays: ['wss://r'] }).connection
    const solver = await startSolverRail({ wallet: w, db: dbw, lightning: solverConfig(), network: 'regtest', arkInfo })
    try {
      const inv = peer('addinvoice', '--amt', '3000') // regtest solver fee is 0 → 1 sat residue
      const res = (await handlePayInvoice(
        { lightning: { solver, subdustdUrl: SUBDUSTD_URL! }, db: dbw, conn: connw, eventId: 'evt-d', wallet: w, arkServerUrl: ARKD },
        { invoice: inv.payment_request },
      )) as { preimage: string }
      expect(sha256(res.preimage)).toBe(inv.r_hash)
      await waitFor('only the 1-sat residue left', async () => {
        const left = await w.getVtxos()
        return left.length === 1 && left[0]!.value === 1 ? true : undefined
      }, 30_000)
      expect(await w.getSpendableVtxos({ withRecoverable: false } as never)).toEqual([])
    } finally {
      await solver.dispose()
      await w.dispose()
    }
  }, 300_000)
})
