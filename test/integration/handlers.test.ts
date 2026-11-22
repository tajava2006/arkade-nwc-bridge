import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config'
import { NwcError } from '../../src/lib/errors'
import { handleGetBalance } from '../../src/handlers/get_balance'
import { handleGetInfo } from '../../src/handlers/get_info'
import { handleListTransactions } from '../../src/handlers/list_transactions'
import { handleLookupInvoice } from '../../src/handlers/lookup_invoice'
import { handleMakeInvoice } from '../../src/handlers/make_invoice'
import { handlePayInvoice } from '../../src/handlers/pay_invoice'
import { createConnection, type Connection } from '../../src/nostr/connections'
import { openTempDb, type TempDb } from '../helpers/db'
import {
  INVOICE_2000_SAT,
  emptyBalance,
  fakeInvoiceResponse,
  fakeSpendableVtxo,
  makeSwapsStub,
  knownPreimageInvoice,
  makeLightningStub,
  stubSubdustdReceive,
  makeWalletStub,
} from '../helpers/mocks'

// The submarine rail reads dust (change guard) + deprecatedSigners (the
// explicit-selection safety valve) before picking inputs; injected so these
// stay offline.

const CFG = {
  network: 'bitcoin',
  arkServerUrl: '',
  boltzApiUrl: '',
  esploraUrls: ['https://stub-esplora'],
  nwcRelays: ['wss://r'],
  httpBind: '127.0.0.1',
  httpPort: 0,
  dbPath: '',
} as Config

function newConn(temp: TempDb): Connection {
  return createConnection(temp.db, { label: null, relays: ['wss://r'] }).connection
}

describe('handlers', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  describe('get_info', () => {
    test('returns network + advertised methods (mainnet maps to "mainnet")', () => {
      const r = handleGetInfo({ cfg: CFG }) as { network: string; methods: string[] }
      expect(r.network).toBe('mainnet')
      expect(r.methods).toContain('pay_invoice')
      expect(r.methods).toContain('make_invoice')
    })

    test('mutinynet maps to "signet"', () => {
      const r = handleGetInfo({ cfg: { ...CFG, network: 'mutinynet' } }) as { network: string }
      expect(r.network).toBe('signet')
    })
  })

  describe('get_balance', () => {
    test('returns (available + recoverable) × 1000 msat', async () => {
      const wallet = makeWalletStub({
        balance: emptyBalance({ available: 1_000, recoverable: 50 }),
      })
      const r = await handleGetBalance({ wallet })
      expect(r).toEqual({ balance: 1_050_000 })
    })

    test('excludes boarding (it has to round-trip first)', async () => {
      const wallet = makeWalletStub({
        balance: emptyBalance({
          available: 200,
          recoverable: 0,
          boarding: { confirmed: 100_000, unconfirmed: 0, total: 100_000 },
        }),
      })
      const r = await handleGetBalance({ wallet })
      expect(r).toEqual({ balance: 200_000 })
    })
  })

  describe('make_invoice', () => {
    // issueInvoice's sub-dust branch talks to boltz over plain fetch —
    // intercept per-test and restore so other suites see the real one.
    const realFetch = globalThis.fetch
    afterEach(() => {
      globalThis.fetch = realFetch
    })

    const mkDeps = (conn: Connection, eventId: string) => ({
      lightning: { subdustdUrl: 'http://subdustd.invalid' },
      db: temp.db,
      conn,
      eventId,
      wallet: makeWalletStub(),
      arkServerUrl: 'http://arkd.invalid',
    })

    test('rejects non-positive amounts with OTHER', async () => {
      const deps = mkDeps(newConn(temp), 'evt-a')
      await expect(handleMakeInvoice(deps, { amount: -1 })).rejects.toMatchObject({ code: 'OTHER' })
      await expect(handleMakeInvoice(deps, {})).rejects.toMatchObject({ code: 'OTHER' })
    })

    test('rejects sub-sat amounts (non-multiple of 1000 msat) with OTHER', async () => {
      await expect(handleMakeInvoice(mkDeps(newConn(temp), 'evt-b'), { amount: 1500 })).rejects.toMatchObject({ code: 'OTHER' })
    })

    test('rejects a malformed description_hash with OTHER', async () => {
      await expect(
        handleMakeInvoice(mkDeps(newConn(temp), 'evt-b2'), { amount: 1_000_000, description_hash: 'not-hex' }),
      ).rejects.toMatchObject({ code: 'OTHER' })
    })

    test('an Ark-only bridge refuses with NOT_IMPLEMENTED', async () => {
      await expect(
        handleMakeInvoice({ ...mkDeps(newConn(temp), 'evt-noln'), lightning: undefined }, { amount: 1_000_000 }),
      ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    })

    test('inserts a pending row — amount = BOLT11 nominal, no fee (1:1), matched later by payment hash', async () => {
      const { bodies } = stubSubdustdReceive('http://subdustd.invalid')
      const r = (await handleMakeInvoice(mkDeps(newConn(temp), 'evt-c'), { amount: 1_000_000, description: 'tea' })) as Record<string, unknown>
      expect(bodies[0]).toMatchObject({ amount: 1000, description: 'tea' })
      expect(r).toMatchObject({ type: 'incoming', state: 'pending', amount: 1_000_000, description: 'tea' })
      expect(r.fees_paid).toBeUndefined()
      const row = temp.db
        .query<{ state: string; amount_msat: number; fees_paid_msat: number; payment_hash: string; swap_id: string | null; expires_at: number | null }, []>(
          `SELECT state, amount_msat, fees_paid_msat, payment_hash, swap_id, expires_at FROM transactions`,
        )
        .get()!
      expect(row).toMatchObject({ state: 'pending', amount_msat: 1_000_000, fees_paid_msat: 0, swap_id: null })
      expect(row.payment_hash).toBe(String(r.payment_hash))
      expect(typeof row.expires_at).toBe('number')
    })

    test('a NIP-57 zap: description_hash reaches subdustd (a 21-sat zap is a 21-sat invoice)', async () => {
      const { bodies } = stubSubdustdReceive('http://subdustd.invalid')
      const r = (await handleMakeInvoice(mkDeps(newConn(temp), 'evt-z'), { amount: 21_000, description_hash: 'cd'.repeat(32) })) as Record<string, unknown>
      expect(bodies[0]).toMatchObject({ amount: 21, descriptionHash: 'cd'.repeat(32) })
      expect(r.amount).toBe(21_000)
    })

    test('a subdustd refusal is an OTHER error and leaves no row', async () => {
      globalThis.fetch = (async () => new Response('no float', { status: 503 })) as unknown as typeof fetch
      await expect(handleMakeInvoice(mkDeps(newConn(temp), 'evt-r'), { amount: 1_000_000 })).rejects.toMatchObject({ code: 'OTHER' })
      expect(temp.db.query('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({ n: 0 })
    })
  })

  describe('pay_invoice', () => {
    const payDeps = (conn: Connection, eventId: string, lightning = makeLightningStub().lightning) => ({
      lightning,
      db: temp.db,
      conn,
      eventId,
      wallet: makeWalletStub(),
      arkServerUrl: 'http://arkd.invalid',
    })
    const rowOf = (eventId: string) =>
      temp.db
        .query<{ state: string; amount_msat: number; fees_paid_msat: number | null; preimage: string | null; error: string | null; swap_id: string | null }, [string]>(
          `SELECT state, amount_msat, fees_paid_msat, preimage, error, swap_id FROM transactions WHERE request_event_id = ?`,
        )
        .get(eventId)
    const spentOf = (conn: Connection) =>
      temp.db.query<{ spent_msat: number }, [number]>('SELECT spent_msat FROM connections WHERE id = ?').get(conn.id)!.spent_msat

    test('rejects missing/invalid invoice with OTHER', async () => {
      const deps = payDeps(newConn(temp), 'evt-d')
      await expect(handlePayInvoice(deps, {})).rejects.toMatchObject({ code: 'OTHER' })
      await expect(handlePayInvoice(deps, { invoice: 'not-a-bolt11' })).rejects.toMatchObject({ code: 'OTHER' })
    })

    test('an Ark-only bridge (no Lightning rails) refuses with NOT_IMPLEMENTED', async () => {
      const deps = { ...payDeps(newConn(temp), 'evt-noln'), lightning: undefined }
      await expect(handlePayInvoice(deps, { invoice: INVOICE_2000_SAT })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    })

    test('over-budget connections fail with QUOTA_EXCEEDED', async () => {
      const conn = createConnection(temp.db, { label: null, relays: ['wss://r'], budgetMsat: 500_000 }).connection
      await expect(handlePayInvoice(payDeps(conn, 'evt-e'), { invoice: INVOICE_2000_SAT })).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      })
    })

    test('successful pay: amount stays the nominal, fees_paid is the solver fee, budget books both', async () => {
      const conn = newConn(temp)
      const { preimage, invoice } = knownPreimageInvoice()
      const { lightning } = makeLightningStub({ feeSats: 5, preimage })
      const r = (await handlePayInvoice(payDeps(conn, 'evt-f', lightning), { invoice })) as Record<string, unknown>
      expect(r.preimage).toBe(preimage)
      expect(r.fees_paid).toBe(5_000)
      const row = rowOf('evt-f')!
      expect(row.state).toBe('settled')
      expect(row.amount_msat).toBe(2_000_000) // stays the BOLT11 nominal — fee is separate
      expect(row.fees_paid_msat).toBe(5_000)
      expect(row.swap_id).toBe('rfq:00112233445566778899aabbccddeeff')
      expect(spentOf(conn)).toBe(2_005_000) // budget tracks wallet movement, fee included
    })

    test('a zero-fee pay reports no fees_paid', async () => {
      const { preimage, invoice } = knownPreimageInvoice()
      const r = (await handlePayInvoice(payDeps(newConn(temp), 'evt-f0', makeLightningStub({ preimage }).lightning), {
        invoice,
      })) as Record<string, unknown>
      expect(r.fees_paid).toBeUndefined()
    })

    test('periodic renewal: spend from a previous window does not count', async () => {
      // 2500 sat daily budget with 1000 sats spent two days ago — lifetime
      // total (3000) would bust the cap, the daily window (2000) does not.
      const conn = createConnection(temp.db, { label: null, relays: ['wss://r'], budgetMsat: 2_500_000, budgetRenewal: 'daily' }).connection
      temp.db
        .query(
          `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, state, created_at)
           VALUES (?, 'outgoing', 'evt-old', 'lnbc1', 'hash-old', ?, 'settled', ?)`,
        )
        .run(conn.id, 1_000_000, Math.floor(Date.now() / 1000) - 2 * 86_400)
      temp.db.query('UPDATE connections SET spent_msat = ? WHERE id = ?').run(1_000_000, conn.id)
      const { preimage, invoice } = knownPreimageInvoice()
      const res = (await handlePayInvoice(payDeps(conn, 'evt-window', makeLightningStub({ feeSats: 5, preimage }).lightning), {
        invoice,
      })) as Record<string, unknown>
      expect(res.preimage).toBe(preimage)
    })

    test('never renewal: the same lifetime spend still busts the cap', async () => {
      const conn = createConnection(temp.db, { label: null, relays: ['wss://r'], budgetMsat: 2_500_000, budgetRenewal: 'never' }).connection
      temp.db.query('UPDATE connections SET spent_msat = ? WHERE id = ?').run(1_000_000, conn.id)
      await expect(handlePayInvoice(payDeps(conn, 'evt-life'), { invoice: INVOICE_2000_SAT })).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      })
    })

    test('pending payments reserve budget', async () => {
      const conn = createConnection(temp.db, { label: null, relays: ['wss://r'], budgetMsat: 2_500_000, budgetRenewal: 'daily' }).connection
      temp.db
        .query(
          `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, state, created_at)
           VALUES (?, 'outgoing', 'evt-inflight', 'lnbc1', 'hash-p', ?, 'pending', ?)`,
        )
        .run(conn.id, 1_000_000, Math.floor(Date.now() / 1000))
      await expect(handlePayInvoice(payDeps(conn, 'evt-reserve'), { invoice: INVOICE_2000_SAT })).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      })
    })

    test('a refunded swap marks the row failed and throws PAYMENT_FAILED', async () => {
      const { invoice } = knownPreimageInvoice()
      await expect(
        handlePayInvoice(payDeps(newConn(temp), 'evt-g', makeLightningStub({ finalOutcome: 'refunded' }).lightning), { invoice }),
      ).rejects.toMatchObject({ code: 'PAYMENT_FAILED' })
      expect(rowOf('evt-g')).toMatchObject({ state: 'failed' })
      expect(rowOf('evt-g')!.error).toContain('refunded')
    })

    test('a solver refusal for funds is INSUFFICIENT_BALANCE, row failed', async () => {
      const { InsufficientFunds } = await import('@arkade-os/swap')
      const refusal = Object.setPrototypeOf(Object.assign(new Error('balance 10 < 2000'), { name: 'InsufficientFunds' }), InsufficientFunds.prototype)
      const { invoice } = knownPreimageInvoice()
      await expect(
        handlePayInvoice(payDeps(newConn(temp), 'evt-g2', makeLightningStub({ payError: refusal }).lightning), { invoice }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
      expect(rowOf('evt-g2')).toMatchObject({ state: 'failed' })
    })

    test('an unresolved outcome keeps the row pending (reservation held, retry refused)', async () => {
      const conn = newConn(temp)
      const { invoice } = knownPreimageInvoice()
      await expect(
        handlePayInvoice(payDeps(conn, 'evt-u', makeLightningStub({ finalOutcome: 'needs_recovery' }).lightning), { invoice }),
      ).rejects.toMatchObject({ code: 'INTERNAL' })
      expect(rowOf('evt-u')).toMatchObject({ state: 'pending', swap_id: 'rfq:00112233445566778899aabbccddeeff' })
      await expect(handlePayInvoice(payDeps(conn, 'evt-u2'), { invoice })).rejects.toThrow(/already being paid/)
    })
  })

  describe('lookup_invoice', () => {
    test('NOT_FOUND when no row matches', async () => {
      const conn = newConn(temp)
      await expect(
        handleLookupInvoice({ db: temp.db, conn }, { payment_hash: 'ff'.repeat(32) }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    test('OTHER when neither payment_hash nor invoice given', async () => {
      const conn = newConn(temp)
      await expect(handleLookupInvoice({ db: temp.db, conn }, {})).rejects.toMatchObject({
        code: 'OTHER',
      })
    })

    test('connection-scoped: never returns another connection\'s row', async () => {
      const a = newConn(temp)
      const b = newConn(temp)
      temp.db
        .query(
          `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, state, created_at)
           VALUES (?, 'incoming', 'evt-other', 'lnbc-x', 'cafe', 1000, 'settled', 1)`,
        )
        .run(a.id)
      // Look up the *exact* same payment hash but from connection B — must
      // not see it. This is the isolation invariant from CLAUDE.md.
      await expect(
        handleLookupInvoice({ db: temp.db, conn: b }, { payment_hash: 'cafe' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      // Same hash from A returns it.
      const r = await handleLookupInvoice({ db: temp.db, conn: a }, { payment_hash: 'cafe' })
      expect((r as Record<string, unknown>).invoice).toBe('lnbc-x')
    })
  })

  describe('list_transactions', () => {
    function insertTx(
      connId: number,
      eventId: string,
      type: 'incoming' | 'outgoing',
      state: string,
      createdAt: number,
    ) {
      temp.db
        .query(
          `INSERT INTO transactions (connection_id, type, request_event_id, invoice, payment_hash, amount_msat, state, created_at)
           VALUES (?, ?, ?, 'lnbc', 'ph-${eventId}', 1000, ?, ?)`,
        )
        .run(connId, type, eventId, state, createdAt)
    }

    test('only settled by default, only the connection\'s rows, DESC by created_at', async () => {
      const a = newConn(temp)
      const b = newConn(temp)
      insertTx(a.id, 'a1', 'incoming', 'settled', 100)
      insertTx(a.id, 'a2', 'outgoing', 'pending', 200)
      insertTx(a.id, 'a3', 'incoming', 'settled', 300)
      insertTx(b.id, 'b1', 'incoming', 'settled', 250)

      const r = (await handleListTransactions({ db: temp.db, conn: a }, {})) as {
        transactions: Array<Record<string, unknown>>
      }
      expect(r.transactions.map((t) => t.payment_hash)).toEqual(['ph-a3', 'ph-a1'])
    })

    test('unpaid=true includes pending; type filter narrows', async () => {
      const a = newConn(temp)
      insertTx(a.id, 'a1', 'incoming', 'pending', 100)
      insertTx(a.id, 'a2', 'outgoing', 'settled', 200)

      const all = (await handleListTransactions(
        { db: temp.db, conn: a },
        { unpaid: true },
      )) as { transactions: unknown[] }
      expect(all.transactions).toHaveLength(2)

      const onlyOut = (await handleListTransactions(
        { db: temp.db, conn: a },
        { unpaid: true, type: 'outgoing' },
      )) as { transactions: Array<Record<string, unknown>> }
      expect(onlyOut.transactions).toHaveLength(1)
      expect(onlyOut.transactions[0]?.type).toBe('outgoing')
    })

    test('limit is clamped to [1, 100]', async () => {
      const a = newConn(temp)
      for (let i = 0; i < 5; i++) insertTx(a.id, `e${i}`, 'incoming', 'settled', 100 + i)
      const r = (await handleListTransactions({ db: temp.db, conn: a }, { limit: 2 })) as {
        transactions: unknown[]
      }
      expect(r.transactions).toHaveLength(2)
    })

    test('rejects invalid type with OTHER', async () => {
      const a = newConn(temp)
      await expect(
        handleListTransactions({ db: temp.db, conn: a }, { type: 'whatever' }),
      ).rejects.toBeInstanceOf(NwcError)
    })
  })
})
