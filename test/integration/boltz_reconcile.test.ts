import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import {
  isReverseFinalStatus,
  isReverseSuccessStatus,
  isSubmarineFinalStatus,
  isSubmarineSuccessStatus,
  type BoltzReverseSwap,
  type BoltzSubmarineSwap,
} from '@arkade-os/boltz-swap'

import { ArkAddress } from '@arkade-os/sdk'
import { hex } from '@scure/base'

import { onSwapTerminal, reconcilePendingIncoming, syncSwapToDb, type VtxoIndexer } from '../../src/boltz'
import { createConnection } from '../../src/nostr/connections'
import { openTempDb, type TempDb } from '../helpers/db'
import { INVOICE_21_SAT } from '../helpers/mocks'
import { SqliteAtomicSwapRepository, SwapDirection, type AtomicSwapState } from '../../src/atomic'

// Boot-time drift repair between the SDK's boltz_swaps table and the bridge's
// transactions table. This area has a production incident on record (a stuck
// swap row wedging boot until it was hand-deleted from sqlite) — these tests
// pin the invariants that keep boot inert in the face of weird rows: only
// TERMINAL swaps flip transactions, everything else (in-flight, orphaned,
// already-resolved) is left exactly as found.

const PREIMAGE = 'aa'.repeat(32)

// ── M3 landing-verification fixtures ─────────────────────────────────────────
// confirmReverseLanded binds by txid, never by amount: the swap's VHTLC lockup
// script must be SPENT, and the spending Arkade tx must have created a coin at
// OUR script. Real bech32m addresses so ArkAddress.decode works; the key bytes
// are arbitrary (only length is checked).
const SERVER_KEY = new Uint8Array(32).fill(3)
const LOCKUP_ADDR = new ArkAddress(SERVER_KEY, new Uint8Array(32).fill(7), 'tark').encode()
const OUR_ADDR = new ArkAddress(SERVER_KEY, new Uint8Array(32).fill(9), 'tark').encode()
const LOCKUP_SCRIPT = hex.encode(ArkAddress.decode(LOCKUP_ADDR).pkScript)
const OUR_SCRIPT = hex.encode(ArkAddress.decode(OUR_ADDR).pkScript)

// The wallet's only job in the confirm path is telling us OUR address.
function stubWallet(): Parameters<typeof reconcilePendingIncoming>[1] {
  return { getAddress: async () => OUR_ADDR } as Parameters<typeof reconcilePendingIncoming>[1]
}

// Script-keyed indexer stub: maps a queried pkScript (hex) to its coins.
function stubIndexer(byScript: Record<string, unknown[]>): VtxoIndexer {
  return {
    getVtxos: async (opts?: { scripts?: string[] }) => ({
      vtxos: (opts?.scripts ?? []).flatMap((s) => byScript[s] ?? []),
    }),
  } as VtxoIndexer
}

/** VHTLC spent by claim arkTx `claimtx` + our coin created by that same tx. */
function landedIndexer(): VtxoIndexer {
  return stubIndexer({
    [LOCKUP_SCRIPT]: [{ txid: 'vhtlc', vout: 0, value: 21, arkTxId: 'claimtx' }],
    [OUR_SCRIPT]: [{ txid: 'claimtx', vout: 0, value: 21 }],
  })
}

function connId(temp: TempDb): number {
  return createConnection(temp.db, { label: null, relays: ['wss://r'] }).connection.id
}

function insertPendingTx(
  temp: TempDb,
  over: { type?: 'incoming' | 'outgoing'; swapId?: string | null; state?: string } = {},
): void {
  temp.db
    .query(
      `INSERT INTO transactions (
         connection_id, type, request_event_id, invoice, payment_hash,
         amount_msat, fees_paid_msat, swap_id, state, created_at
       ) VALUES (?, ?, ?, 'lnbcfake', ?, 21000, 0, ?, ?, ?)`,
    )
    .run(
      connId(temp),
      over.type ?? 'incoming',
      `evt-${Math.random()}`,
      'ff'.repeat(32),
      over.swapId === undefined ? 'swap-1' : over.swapId,
      over.state ?? 'pending',
      Math.floor(Date.now() / 1000),
    )
}

function insertSwapRow(temp: TempDb, id: string, status: string, data: unknown): void {
  temp.db
    .query(`INSERT INTO boltz_swaps (id, type, status, created_at, data) VALUES (?, ?, ?, ?, ?)`)
    .run(
      id,
      (data as { type: string }).type,
      status,
      Math.floor(Date.now() / 1000),
      JSON.stringify(data),
    )
}

function txRow(temp: TempDb): { state: string; preimage: string | null; settled_at: number | null } {
  return temp.db
    .query<{ state: string; preimage: string | null; settled_at: number | null }, []>(
      `SELECT state, preimage, settled_at FROM transactions LIMIT 1`,
    )
    .get()!
}

describe('boltz boot reconcile', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('terminal SUCCESS swap flips the stale pending row to settled + backfills', async () => {
    // guard the fixture's premise against upstream status-set drift
    expect(isReverseFinalStatus('invoice.settled')).toBe(true)
    expect(isReverseSuccessStatus('invoice.settled')).toBe(true)

    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'invoice.settled', {
      type: 'reverse',
      id: 'swap-1',
      preimage: PREIMAGE,
      request: { invoiceAmount: 21 },
      response: { lockupAddress: LOCKUP_ADDR },
    })
    await reconcilePendingIncoming(temp.db, stubWallet(), landedIndexer())

    const row = txRow(temp)
    expect(row.state).toBe('settled')
    expect(row.preimage).toBe(PREIMAGE)
    expect(row.settled_at).not.toBeNull()
  })

  test('a success boltz claims but whose VHTLC is unspent is deferred (M3), not settled', async () => {
    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'invoice.settled', {
      type: 'reverse',
      id: 'swap-1',
      preimage: PREIMAGE,
      request: { invoiceAmount: 21 },
      response: { lockupAddress: LOCKUP_ADDR },
    })
    // boltz lied / the claim hasn't landed: the lockup coin exists but nothing spent it
    const idx = stubIndexer({ [LOCKUP_SCRIPT]: [{ txid: 'vhtlc', vout: 0, value: 21 }] })
    await reconcilePendingIncoming(temp.db, stubWallet(), idx)
    expect(txRow(temp).state).toBe('pending')
  })

  test('exact binding: a same-value coin NOT created by this swap\'s claim does not confirm', async () => {
    // The user-level invariant: amounts are never evidence. Our wallet holds a
    // 21-sat coin, but its txid is not the tx that spent THIS swap's VHTLC —
    // so the row must stay pending, no matter how well the value matches.
    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'invoice.settled', {
      type: 'reverse',
      id: 'swap-1',
      preimage: PREIMAGE,
      request: { invoiceAmount: 21 },
      response: { lockupAddress: LOCKUP_ADDR },
    })
    const idx = stubIndexer({
      [LOCKUP_SCRIPT]: [{ txid: 'vhtlc', vout: 0, value: 21, arkTxId: 'claim-of-swap-1' }],
      [OUR_SCRIPT]: [{ txid: 'coin-from-some-other-swap', vout: 0, value: 21 }],
    })
    await reconcilePendingIncoming(temp.db, stubWallet(), idx)
    expect(txRow(temp).state).toBe('pending')
  })

  test('batch-path claim confirms via settledBy ↔ commitmentTxIds (still txid-bound)', async () => {
    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'invoice.settled', {
      type: 'reverse',
      id: 'swap-1',
      preimage: PREIMAGE,
      request: { invoiceAmount: 21 },
      response: { lockupAddress: LOCKUP_ADDR },
    })
    // recoverable VHTLC claimed through a settlement round: the VHTLC was
    // absorbed by commitment `commit-1`, and our coin hangs off that commitment
    const idx = stubIndexer({
      [LOCKUP_SCRIPT]: [{ txid: 'vhtlc', vout: 0, value: 21, settledBy: 'commit-1' }],
      [OUR_SCRIPT]: [
        { txid: 'leaf', vout: 0, value: 21, virtualStatus: { state: 'settled', commitmentTxIds: ['commit-1'] } },
      ],
    })
    await reconcilePendingIncoming(temp.db, stubWallet(), idx)
    expect(txRow(temp).state).toBe('settled')
  })

  test('a swap blob without lockupAddress cannot be verified — deferred', async () => {
    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'invoice.settled', {
      type: 'reverse',
      id: 'swap-1',
      preimage: PREIMAGE,
      request: { invoiceAmount: 21 },
    })
    await reconcilePendingIncoming(temp.db, stubWallet(), landedIndexer())
    expect(txRow(temp).state).toBe('pending')
  })

  test('terminal FAILURE swap flips it to failed', async () => {
    expect(isReverseFinalStatus('swap.expired')).toBe(true)
    expect(isReverseSuccessStatus('swap.expired')).toBe(false)

    insertPendingTx(temp)
    // preimage present in the swap blob (locally generated) — must NOT be
    // copied onto the failed row, or lookup_invoice serves payment evidence
    // for an invoice nobody paid.
    insertSwapRow(temp, 'swap-1', 'swap.expired', { type: 'reverse', id: 'swap-1', preimage: PREIMAGE })
    await reconcilePendingIncoming(temp.db, stubWallet(), stubIndexer({}))
    const row = txRow(temp)
    expect(row.state).toBe('failed')
    expect(row.preimage).toBeNull()
  })

  test('in-flight swap is left pending — resume owns it, boot must not touch it', async () => {
    expect(isReverseFinalStatus('transaction.mempool')).toBe(false)

    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'transaction.mempool', { type: 'reverse', id: 'swap-1' })
    await reconcilePendingIncoming(temp.db, stubWallet(), stubIndexer({}))
    expect(txRow(temp).state).toBe('pending')
  })

  test('orphaned swap_id (no boltz_swaps row) is skipped without wedging boot', async () => {
    insertPendingTx(temp) // swap-1 referenced, never inserted
    await expect(reconcilePendingIncoming(temp.db, stubWallet(), stubIndexer({}))).resolves.toBeUndefined()
    expect(txRow(temp).state).toBe('pending')
  })

  test('sub-dust rows (NULL swap_id) are not reconcile material', async () => {
    insertPendingTx(temp, { swapId: null }) // ln_receive's 30s reconciler owns these
    await expect(reconcilePendingIncoming(temp.db, stubWallet(), stubIndexer({}))).resolves.toBeUndefined()
    expect(txRow(temp).state).toBe('pending')
  })

  test('operator DM: settled fires exactly once across passes, failed stays silent', async () => {
    const calls: Array<{ kind: string; text: string }> = []
    const notify = (kind: string, build: () => string): void => {
      calls.push({ kind, text: build() })
    }

    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'invoice.settled', {
      type: 'reverse',
      id: 'swap-1',
      preimage: PREIMAGE,
      request: { invoiceAmount: 21 },
      response: { lockupAddress: LOCKUP_ADDR },
    })
    await reconcilePendingIncoming(temp.db, stubWallet(), landedIndexer(), notify as never)
    expect(calls.length).toBe(1)
    expect(calls[0]!.kind).toBe('recv-ln')
    expect(calls[0]!.text).toContain('21 sats')

    // Second boot: the row is settled now — rows-changed gate keeps quiet.
    await reconcilePendingIncoming(temp.db, stubWallet(), landedIndexer(), notify as never)
    expect(calls.length).toBe(1)

    // A failure flip is unpaid-expiry noise — never DMed.
    insertPendingTx(temp, { swapId: 'swap-2' })
    insertSwapRow(temp, 'swap-2', 'swap.expired', { type: 'reverse', id: 'swap-2' })
    await reconcilePendingIncoming(temp.db, stubWallet(), stubIndexer({}), notify as never)
    expect(calls.length).toBe(1)
  })
})

describe('syncSwapToDb (swap event → table sync)', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  const reverseSwap = { type: 'reverse', id: 'swap-1', preimage: PREIMAGE } as BoltzReverseSwap
  const submarineSwap = { type: 'submarine', id: 'swap-1', preimage: PREIMAGE } as BoltzSubmarineSwap

  test('reverse event settles the matching INCOMING row only', () => {
    insertPendingTx(temp, { type: 'incoming' })
    insertPendingTx(temp, { type: 'outgoing' })
    syncSwapToDb(temp.db, reverseSwap, 'settled')

    const rows = temp.db
      .query<{ type: string; state: string }, []>(`SELECT type, state FROM transactions`)
      .all()
    expect(rows.find((r) => r.type === 'incoming')!.state).toBe('settled')
    expect(rows.find((r) => r.type === 'outgoing')!.state).toBe('pending')
  })

  test('submarine event settles the matching OUTGOING row only', () => {
    insertPendingTx(temp, { type: 'incoming' })
    insertPendingTx(temp, { type: 'outgoing' })
    syncSwapToDb(temp.db, submarineSwap, 'settled')

    const rows = temp.db
      .query<{ type: string; state: string }, []>(`SELECT type, state FROM transactions`)
      .all()
    expect(rows.find((r) => r.type === 'incoming')!.state).toBe('pending')
    expect(rows.find((r) => r.type === 'outgoing')!.state).toBe('settled')
  })

  test('a late event cannot undo what the handler already recorded (pending gate)', () => {
    insertPendingTx(temp, { type: 'incoming', state: 'settled' })
    syncSwapToDb(temp.db, reverseSwap, 'failed')
    expect(txRow(temp).state).toBe('settled') // resumed-swap failure arrives after the fact — ignored
  })

  test('submarine failure records the error without clobbering an existing one', () => {
    insertPendingTx(temp, { type: 'outgoing' })
    syncSwapToDb(temp.db, submarineSwap, 'failed', 'route not found')
    const row = temp.db
      .query<{ state: string; error: string | null }, []>(
        `SELECT state, error FROM transactions LIMIT 1`,
      )
      .get()!
    expect(row.state).toBe('failed')
    expect(row.error).toBe('route not found')
  })
})

describe('onSwapTerminal (SDK terminal event → success/failure routing)', () => {
  // The SDK's onSwapCompleted means "monitoring completed" — it fires on EVERY
  // terminal status, expiry included (finalizeMonitoredSwap). These pin that
  // the bridge routes on swap.status, not on the event: the 2026-07-29
  // incident recorded an unpaid invoice.expired receive as settled.
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  type Notify = Array<{ kind: string; text: string }>
  function collector(): { calls: Notify; notify: (kind: string, build: () => string) => void } {
    const calls: Notify = []
    return { calls, notify: (kind, build) => calls.push({ kind, text: build() }) }
  }

  test('reverse invoice.expired → failed, no preimage, no settle hook (2026-07-29 regression)', async () => {
    // guard the fixture's premise against upstream status-set drift
    expect(isReverseFinalStatus('invoice.expired')).toBe(true)
    expect(isReverseSuccessStatus('invoice.expired')).toBe(false)

    insertPendingTx(temp)
    const swap = {
      type: 'reverse',
      id: 'swap-1',
      status: 'invoice.expired',
      preimage: PREIMAGE, // locally generated — exists even though nobody paid
      request: { invoiceAmount: 21 },
    } as BoltzReverseSwap
    const { calls, notify } = collector()
    let settleHookFired = false
    // failure routing must short-circuit BEFORE any landing check — an indexer
    // that throws proves the confirm path is never consulted for a failure
    const explodingIndexer = { getVtxos: async () => { throw new Error('confirm path must not run') } } as never
    await onSwapTerminal(
      { db: temp.db, wallet: stubWallet(), indexer: explodingIndexer, onReverseSettled: () => { settleHookFired = true }, notify: notify as never },
      swap,
    )

    const row = txRow(temp)
    expect(row.state).toBe('failed')
    expect(row.preimage).toBeNull()
    expect(settleHookFired).toBe(false)
    expect(calls.length).toBe(0) // unpaid expiry is routine noise
  })

  test('reverse expired swap is failed even when a same-value coin exists (twin scenario)', async () => {
    // The incident's exact shape: two same-amount invoices seconds apart, the
    // later one paid. The paid twin's coin sits at our script — the expired
    // swap must still classify as failed: status routing wins, and the confirm
    // path binds by txid anyway, never by value.
    insertPendingTx(temp)
    const swap = {
      type: 'reverse',
      id: 'swap-1',
      status: 'invoice.expired',
      preimage: PREIMAGE,
      request: { invoiceAmount: 21 },
      response: { lockupAddress: LOCKUP_ADDR },
    } as BoltzReverseSwap
    const idx = stubIndexer({
      [LOCKUP_SCRIPT]: [{ txid: 'vhtlc', vout: 0, value: 21 }], // this swap: never claimed
      [OUR_SCRIPT]: [{ txid: 'twin-claim', vout: 0, value: 21 }], // the OTHER swap's coin
    })
    await onSwapTerminal({ db: temp.db, wallet: stubWallet(), indexer: idx }, swap)
    expect(txRow(temp).state).toBe('failed')
  })

  test('reverse invoice.settled with the vtxo landed → settled + settle hook', async () => {
    insertPendingTx(temp)
    const swap = {
      type: 'reverse',
      id: 'swap-1',
      status: 'invoice.settled',
      preimage: PREIMAGE,
      request: { invoiceAmount: 21 },
      response: { lockupAddress: LOCKUP_ADDR },
    } as BoltzReverseSwap
    let settleHookFired = false
    await onSwapTerminal(
      { db: temp.db, wallet: stubWallet(), indexer: landedIndexer(), onReverseSettled: () => { settleHookFired = true } },
      swap,
    )

    const row = txRow(temp)
    expect(row.state).toBe('settled')
    expect(row.preimage).toBe(PREIMAGE)
    expect(settleHookFired).toBe(true)
  })

  test('submarine invoice.failedToPay → failed + send-fail DM, never "LN paid"', async () => {
    expect(isSubmarineFinalStatus('invoice.failedToPay')).toBe(true)
    expect(isSubmarineSuccessStatus('invoice.failedToPay')).toBe(false)

    insertPendingTx(temp, { type: 'outgoing' })
    const swap = {
      type: 'submarine',
      id: 'swap-1',
      status: 'invoice.failedToPay',
      request: { invoice: INVOICE_21_SAT },
      response: { expectedAmount: 26 },
    } as BoltzSubmarineSwap
    const { calls, notify } = collector()
    await onSwapTerminal({ db: temp.db, wallet: stubWallet(), indexer: stubIndexer({}), notify: notify as never }, swap)

    const row = temp.db
      .query<{ state: string; error: string | null }, []>(`SELECT state, error FROM transactions LIMIT 1`)
      .get()!
    expect(row.state).toBe('failed')
    expect(row.error).toContain('invoice.failedToPay')
    expect(calls.length).toBe(1)
    expect(calls[0]!.kind).toBe('send-fail')
    expect(calls[0]!.text).toContain('FAILED')
  })

  test('submarine transaction.claimed → settled + "LN paid" DM', async () => {
    expect(isSubmarineSuccessStatus('transaction.claimed')).toBe(true)

    insertPendingTx(temp, { type: 'outgoing' })
    const swap = {
      type: 'submarine',
      id: 'swap-1',
      status: 'transaction.claimed',
      preimage: PREIMAGE,
      request: { invoice: INVOICE_21_SAT },
      response: { expectedAmount: 26 },
    } as BoltzSubmarineSwap
    const { calls, notify } = collector()
    await onSwapTerminal({ db: temp.db, wallet: stubWallet(), indexer: stubIndexer({}), notify: notify as never }, swap)

    expect(txRow(temp).state).toBe('settled')
    expect(calls.length).toBe(1)
    expect(calls[0]!.kind).toBe('send-ln')
    expect(calls[0]!.text).toContain('LN paid')
  })
})

describe('M1/R2 — outgoing crash-window reconcile (sub-dust atomic send)', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  function makeAtomicSend(state: AtomicSwapState, over: { preimage?: string } = {}) {
    const repo = new SqliteAtomicSwapRepository(temp.db)
    repo.create({
      id: 'atomic-send-1',
      direction: SwapDirection.Send,
      paymentHash: 'ff'.repeat(32),
      state,
      amount: 21,
      refundLocktime: Math.floor(Date.now() / 1000) + 3600,
      preimage: over.preimage ?? 'ee'.repeat(32),
    })
  }

  test('claimed atomic send settles the pending row AND bumps the \'never\' budget counter (R2)', async () => {
    const conn = createConnection(temp.db, { label: null, relays: ['wss://r'] }).connection
    expect(conn.spentMsat).toBe(0)
    // pending outgoing row — insertPendingTx hardcodes payment_hash 'ff'*32 & amount 21000
    insertPendingTx(temp, { type: 'outgoing', state: 'pending' })
    makeAtomicSend('claimed')

    await reconcilePendingIncoming(temp.db, stubWallet(), stubIndexer({}))

    const row = txRow(temp)
    expect(row.state).toBe('settled')
    expect(row.preimage).toBe('ee'.repeat(32))
    const connRow = temp.db
      .query<{ spent_msat: number }, []>(
        `SELECT spent_msat FROM connections
         WHERE id = (SELECT connection_id FROM transactions LIMIT 1)`,
      )
      .get()!
    // amount_msat (21000) rolled from the pending slice into the counter
    expect(connRow.spent_msat).toBe(21000)
  })

  test('refunded atomic send marks the pending row failed (payment never landed)', async () => {
    insertPendingTx(temp, { type: 'outgoing', state: 'pending' })
    makeAtomicSend('refunded')

    await reconcilePendingIncoming(temp.db, stubWallet(), stubIndexer({}))
    expect(txRow(temp).state).toBe('failed')
  })

  test('in-flight atomic send (non-terminal) leaves the row pending', async () => {
    insertPendingTx(temp, { type: 'outgoing', state: 'pending' })
    makeAtomicSend('ln_inflight')

    await reconcilePendingIncoming(temp.db, stubWallet(), stubIndexer({}))
    expect(txRow(temp).state).toBe('pending')
  })
})
