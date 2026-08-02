import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import {
  isReverseFinalStatus,
  isReverseSuccessStatus,
  type BoltzReverseSwap,
  type BoltzSubmarineSwap,
} from '@arkade-os/boltz-swap'

import { reconcilePendingIncoming, syncSwapToDb } from '../../src/boltz'
import { createConnection } from '../../src/nostr/connections'
import { openTempDb, type TempDb } from '../helpers/db'
import { SqliteAtomicSwapRepository, SwapDirection, type AtomicSwapState } from '../../src/atomic'

// Boot-time drift repair between the SDK's boltz_swaps table and the bridge's
// transactions table. This area has a production incident on record (a stuck
// swap row wedging boot until it was hand-deleted from sqlite) — these tests
// pin the invariants that keep boot inert in the face of weird rows: only
// TERMINAL swaps flip transactions, everything else (in-flight, orphaned,
// already-resolved) is left exactly as found.

const PREIMAGE = 'aa'.repeat(32)

// Wallet stub for the M3 confirm gate: getVtxos returns a single vtxo whose
// value is within the confirm tolerance of `value` so a terminal-success swap
// confirms (matches reverseLandedSat's expected ≈ invoiceAmount).
function stubWallet(value: number): Parameters<typeof reconcilePendingIncoming>[1] {
  return { getVtxos: async () => [{ value }] } as Parameters<typeof reconcilePendingIncoming>[1]
}

// Variant carrying createdAt so the R3 filter (vtxo must postdate the swap)
// is actually exercised — stubWallet's dateless vtxos bypass it.
function stubWalletWith(
  vtxos: Array<{ value: number; createdAt?: Date }>,
): Parameters<typeof reconcilePendingIncoming>[1] {
  return { getVtxos: async () => vtxos } as Parameters<typeof reconcilePendingIncoming>[1]
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
    })
    await reconcilePendingIncoming(temp.db, stubWallet(21))

    const row = txRow(temp)
    expect(row.state).toBe('settled')
    expect(row.preimage).toBe(PREIMAGE)
    expect(row.settled_at).not.toBeNull()
  })

  test('a success boltz claims but with NO matching Ark vtxo is deferred (M3), not settled', async () => {
    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'invoice.settled', {
      type: 'reverse',
      id: 'swap-1',
      preimage: PREIMAGE,
      request: { invoiceAmount: 21 },
    })
    // wallet that never shows the 21-sat vtxo (boltz lied / hasn't landed yet)
    await reconcilePendingIncoming(temp.db, stubWallet(9999))
    expect(txRow(temp).state).toBe('pending')
  })

  test('R3: a same-value vtxo that PREdates the swap does not confirm — deferred', async () => {
    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'invoice.settled', {
      type: 'reverse',
      id: 'swap-1',
      preimage: PREIMAGE,
      createdAt: 1_700_000_100, // unix sec — swapCreatedMs baseline
      request: { invoiceAmount: 21 },
    })
    // a leftover 21-sat vtxo from an EARLIER swap — value matches, age rules it out
    await reconcilePendingIncoming(
      temp.db,
      stubWalletWith([{ value: 21, createdAt: new Date(1_700_000_000 * 1000) }]),
    )
    expect(txRow(temp).state).toBe('pending')
  })

  test('R3: a same-value vtxo created after the swap confirms and settles', async () => {
    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'invoice.settled', {
      type: 'reverse',
      id: 'swap-1',
      preimage: PREIMAGE,
      createdAt: 1_700_000_100,
      request: { invoiceAmount: 21 },
    })
    await reconcilePendingIncoming(
      temp.db,
      stubWalletWith([{ value: 21, createdAt: new Date(1_700_000_200 * 1000) }]),
    )
    expect(txRow(temp).state).toBe('settled')
  })

  test('terminal FAILURE swap flips it to failed', async () => {
    expect(isReverseFinalStatus('swap.expired')).toBe(true)
    expect(isReverseSuccessStatus('swap.expired')).toBe(false)

    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'swap.expired', { type: 'reverse', id: 'swap-1' })
    await reconcilePendingIncoming(temp.db, stubWallet(0))
    expect(txRow(temp).state).toBe('failed')
  })

  test('in-flight swap is left pending — resume owns it, boot must not touch it', async () => {
    expect(isReverseFinalStatus('transaction.mempool')).toBe(false)

    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'transaction.mempool', { type: 'reverse', id: 'swap-1' })
    await reconcilePendingIncoming(temp.db, stubWallet(0))
    expect(txRow(temp).state).toBe('pending')
  })

  test('orphaned swap_id (no boltz_swaps row) is skipped without wedging boot', async () => {
    insertPendingTx(temp) // swap-1 referenced, never inserted
    await expect(reconcilePendingIncoming(temp.db, stubWallet(0))).resolves.toBeUndefined()
    expect(txRow(temp).state).toBe('pending')
  })

  test('sub-dust rows (NULL swap_id) are not reconcile material', async () => {
    insertPendingTx(temp, { swapId: null }) // ln_receive's 30s reconciler owns these
    await expect(reconcilePendingIncoming(temp.db, stubWallet(0))).resolves.toBeUndefined()
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
    })
    await reconcilePendingIncoming(temp.db, stubWallet(21), notify as never)
    expect(calls.length).toBe(1)
    expect(calls[0]!.kind).toBe('recv-ln')
    expect(calls[0]!.text).toContain('21 sats')

    // Second boot: the row is settled now — rows-changed gate keeps quiet.
    await reconcilePendingIncoming(temp.db, stubWallet(21), notify as never)
    expect(calls.length).toBe(1)

    // A failure flip is unpaid-expiry noise — never DMed.
    insertPendingTx(temp, { swapId: 'swap-2' })
    insertSwapRow(temp, 'swap-2', 'swap.expired', { type: 'reverse', id: 'swap-2' })
    await reconcilePendingIncoming(temp.db, stubWallet(0), notify as never)
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

    await reconcilePendingIncoming(temp.db, stubWallet(0))

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

    await reconcilePendingIncoming(temp.db, stubWallet(0))
    expect(txRow(temp).state).toBe('failed')
  })

  test('in-flight atomic send (non-terminal) leaves the row pending', async () => {
    insertPendingTx(temp, { type: 'outgoing', state: 'pending' })
    makeAtomicSend('ln_inflight')

    await reconcilePendingIncoming(temp.db, stubWallet(0))
    expect(txRow(temp).state).toBe('pending')
  })
})
