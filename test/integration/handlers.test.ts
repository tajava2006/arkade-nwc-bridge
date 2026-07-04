import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Config } from '../../src/config'
import { NwcError } from '../../src/lib/errors'
import { handleGetBalance } from '../../src/handlers/get_balance'
import { handleGetInfo } from '../../src/handlers/get_info'
import { handleListTransactions } from '../../src/handlers/list_transactions'
import { handleLookupInvoice } from '../../src/handlers/lookup_invoice'
import { handlePayInvoice } from '../../src/handlers/pay_invoice'
import { createConnection, type Connection } from '../../src/nostr/connections'
import { openTempDb, type TempDb } from '../helpers/db'
import {
  emptyBalance,
  fakeInvoiceResponse,
  fakeSpendableVtxo,
  fakeSubmarineSwap,
  makeSwapsStub,
  makeWalletStub,
} from '../helpers/mocks'

const CFG = {
  network: 'bitcoin',
  arkServerUrl: '',
  boltzApiUrl: '',
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
      expect(r.methods).not.toContain('make_invoice') // receive is CLINK-noffer only
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

  describe('pay_invoice', () => {
    // 20μBTC = 2000 sat mainnet invoice with a valid bech32 checksum,
    // borrowed from light-bolt11-decoder's own test vectors. Already
    // expired — we only need it to decode, never to be paid.
    const INVOICE_2000_SAT =
      'lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567'

    test('rejects missing/invalid invoice with OTHER', async () => {
      const conn = newConn(temp)
      const deps = { swaps: makeSwapsStub(), db: temp.db, conn, eventId: 'evt-d', wallet: makeWalletStub(), boltzApiUrl: '' }
      await expect(handlePayInvoice(deps, {})).rejects.toMatchObject({ code: 'OTHER' })
      await expect(handlePayInvoice(deps, { invoice: 'not-a-bolt11' })).rejects.toMatchObject({
        code: 'OTHER',
      })
    })

    test('over-budget connections fail with QUOTA_EXCEEDED', async () => {
      const r = createConnection(temp.db, {
        label: null,
        relays: ['wss://r'],
        budgetMsat: 500_000, // 500 sat budget
      })
      const conn = r.connection
      const deps = { swaps: makeSwapsStub(), db: temp.db, conn, eventId: 'evt-e', wallet: makeWalletStub(), boltzApiUrl: '' }
      // 2000 sat invoice > 500 sat budget
      await expect(
        handlePayInvoice(deps, { invoice: INVOICE_2000_SAT }),
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    })

    test('successful pay updates transaction + connection.spent_msat', async () => {
      const conn = newConn(temp)
      const swaps = makeSwapsStub({
        createSubmarineSwap: async (args) => {
          expect(args.invoice).toBe(INVOICE_2000_SAT)
          // Boltz takes ~5 sat fee on a 2000-sat invoice — total leaving
          // the wallet is 2005 sat.
          return fakeSubmarineSwap({ expectedAmount: 2005 })
        },
        waitForSwapSettlement: async () => ({ preimage: 'be'.repeat(32) }),
      })
      // Well above expectedAmount + drain slack, so the funding stays exact.
      const wallet = makeWalletStub({ vtxos: [fakeSpendableVtxo(10_000)] })
      const r = (await handlePayInvoice(
        { swaps, db: temp.db, conn, eventId: 'evt-f', wallet, boltzApiUrl: '' },
        { invoice: INVOICE_2000_SAT },
      )) as Record<string, unknown>
      expect(r.preimage).toBe('be'.repeat(32))
      expect(r.fees_paid).toBe(5_000)

      const row = temp.db
        .query<
          { state: string; amount_msat: number; fees_paid_msat: number; preimage: string },
          []
        >(`SELECT state, amount_msat, fees_paid_msat, preimage FROM transactions`)
        .get()
      expect(row?.state).toBe('settled')
      expect(row?.amount_msat).toBe(2_005_000)
      expect(row?.fees_paid_msat).toBe(5_000)

      const spent = temp.db
        .query<{ spent_msat: number }, [number]>(
          'SELECT spent_msat FROM connections WHERE id = ?',
        )
        .get(conn.id)
      expect(spent?.spent_msat).toBe(2_000_000) // budget tracks invoice nominal
    })

    test('SDK failure marks the row failed and throws PAYMENT_FAILED', async () => {
      const conn = newConn(temp)
      const swaps = makeSwapsStub({
        createSubmarineSwap: async () => {
          throw new Error('route closed')
        },
      })
      await expect(
        handlePayInvoice(
          { swaps, db: temp.db, conn, eventId: 'evt-g', wallet: makeWalletStub(), boltzApiUrl: '' },
          { invoice: INVOICE_2000_SAT },
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_FAILED' })

      const row = temp.db
        .query<{ state: string; error: string }, []>(
          `SELECT state, error FROM transactions WHERE request_event_id = 'evt-g'`,
        )
        .get()
      expect(row?.state).toBe('failed')
      expect(row?.error).toContain('route closed')
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
