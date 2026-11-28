import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
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
import { openDatabase } from '../../src/db'
import { handleMakeInvoice } from '../../src/handlers/make_invoice'
import { reconcileAtomicReceives } from '../../src/ln_receive'
import { createConnection, type Connection } from '../../src/nostr/connections'

// The LN receive core (SM-44, D10) on the regtest-solver harness: NWC
// make_invoice → subdustd hold invoice → the payer pays → the reconcile pass
// claims and settles, for a regular amount and a sub-dust zap. Run against a
// subdustd built from this checkout (`regtest-solver.sh refresh-subdustd`).
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/ln_receive.test.ts

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
const payers: ChildProcess[] = []
const peerPays = (bolt11: string) =>
  payers.push(spawn('docker', ['exec', 'lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', bolt11], { stdio: 'ignore' }))

describe.skipIf(!SUBDUSTD_URL)('LN receive core on regtest', () => {
  let wallet: Wallet
  let db: Database
  let conn: Connection
  const deps = (eventId: string) => ({ lightning: { subdustdUrl: SUBDUSTD_URL! }, db, conn, eventId, wallet, arkServerUrl: ARKD })
  const row = (eventId: string) =>
    db
      .query<{ state: string; amount_msat: number; fees_paid_msat: number; preimage: string | null; payment_hash: string }, [string]>(
        `SELECT state, amount_msat, fees_paid_msat, preimage, payment_hash FROM transactions WHERE request_event_id = ?`,
      )
      .get(eventId)!
  // The bridge's 30s reconcile tick, run back to back.
  const settle = async (eventId: string) => {
    const until = Date.now() + 120_000
    while (Date.now() < until) {
      await reconcileAtomicReceives({ wallet, subdustdUrl: SUBDUSTD_URL!, arkServerUrl: ARKD, db })
      if (row(eventId).state === 'settled') return row(eventId)
      await Bun.sleep(1000)
    }
    throw new Error(`${eventId} never settled (state ${row(eventId).state})`)
  }

  beforeAll(async () => {
    wallet = await Wallet.create({
      identity: SingleKey.fromPrivateKey(randomBytes(32)),
      operatorProvider: new RestOperatorProvider(ARKD),
      indexerProvider: new RestIndexerProvider(ARKD),
      onchainProvider: new EsploraProvider(ESPLORA, { forcePolling: true, pollingInterval: 2000 }),
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    db = openDatabase(join(mkdtempSync(join(tmpdir(), 'bridge-lnrecv-')), 'bridge.sqlite'))
    conn = createConnection(db, { label: null, relays: ['wss://r'] }).connection
  }, 120_000)

  afterAll(async () => {
    for (const p of payers) p.kill()
    await wallet?.dispose()
  })

  test('a regular amount: the invoice carries the description, the payer pays, a spendable vtxo lands 1:1', async () => {
    const r = (await handleMakeInvoice(deps('evt-1'), { amount: 5_000_000, description: 'tea' })) as { invoice: string; payment_hash: string }
    const decoded = peer('decodepayreq', r.invoice)
    expect(decoded).toMatchObject({ num_satoshis: '5000', description: 'tea', payment_hash: r.payment_hash })
    peerPays(r.invoice)
    const settled = await settle('evt-1')
    expect(sha256(settled.preimage!)).toBe(r.payment_hash)
    expect(settled).toMatchObject({ amount_msat: 5_000_000, fees_paid_msat: 0 })
    // The hold invoice lives on subdustd's LND; settled = the payer's HTLC resolved.
    expect(JSON.parse(sh('exec', 'lnd', 'lncli', '--network=regtest', 'lookupinvoice', r.payment_hash)).state).toBe('SETTLED')
    const coins = await wallet.getSpendableVtxos({ withRecoverable: false } as never)
    expect(coins.map((v) => v.value)).toContain(5_000)
    // ≥ dust → claimed off a VHTLC (F32_VHTLC_PLAN): its terms are on the row, the 4-leaf was never offered
    const row = db
      .query<{ vhtlc: string | null; peer_pubkey: string | null; refund_locktime: number; state: string }, [string]>(
        `SELECT vhtlc, peer_pubkey, refund_locktime, state FROM atomic_swaps WHERE payment_hash = ?`,
      )
      .get(r.payment_hash)!
    expect(row.state).toBe('settled')
    expect(JSON.parse(row.vhtlc!).refundNoReceiverDelaySecs).toBeGreaterThan(JSON.parse(row.vhtlc!).claimDelaySecs)
    expect(row.peer_pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(row.refund_locktime).toBeGreaterThan(Date.now() / 1000)
  }, 300_000)

  test('a 21-sat zap: the invoice is 21 sats with the description hash alone (NIP-57), and settles', async () => {
    const descriptionHash = sha256('ab'.repeat(40))
    const r = (await handleMakeInvoice(deps('evt-2'), { amount: 21_000, description_hash: descriptionHash, description: 'ignored' })) as {
      invoice: string
      payment_hash: string
    }
    const decoded = peer('decodepayreq', r.invoice)
    expect(decoded).toMatchObject({ num_satoshis: '21', description_hash: descriptionHash, description: '' })
    peerPays(r.invoice)
    const settled = await settle('evt-2')
    expect(sha256(settled.preimage!)).toBe(r.payment_hash)
    expect(settled.amount_msat).toBe(21_000)
  }, 300_000)
})
