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

// Boot-time drift repair between the SDK's boltz_swaps table and the bridge's
// transactions table. This area has a production incident on record (a stuck
// swap row wedging boot until it was hand-deleted from sqlite) — these tests
// pin the invariants that keep boot inert in the face of weird rows: only
// TERMINAL swaps flip transactions, everything else (in-flight, orphaned,
// already-resolved) is left exactly as found.

const PREIMAGE = 'aa'.repeat(32)

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

  test('terminal SUCCESS swap flips the stale pending row to settled + backfills', () => {
    // guard the fixture's premise against upstream status-set drift
    expect(isReverseFinalStatus('invoice.settled')).toBe(true)
    expect(isReverseSuccessStatus('invoice.settled')).toBe(true)

    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'invoice.settled', {
      type: 'reverse',
      id: 'swap-1',
      preimage: PREIMAGE,
    })
    reconcilePendingIncoming(temp.db)

    const row = txRow(temp)
    expect(row.state).toBe('settled')
    expect(row.preimage).toBe(PREIMAGE)
    expect(row.settled_at).not.toBeNull()
  })

  test('terminal FAILURE swap flips it to failed', () => {
    expect(isReverseFinalStatus('swap.expired')).toBe(true)
    expect(isReverseSuccessStatus('swap.expired')).toBe(false)

    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'swap.expired', { type: 'reverse', id: 'swap-1' })
    reconcilePendingIncoming(temp.db)
    expect(txRow(temp).state).toBe('failed')
  })

  test('in-flight swap is left pending — resume owns it, boot must not touch it', () => {
    expect(isReverseFinalStatus('transaction.mempool')).toBe(false)

    insertPendingTx(temp)
    insertSwapRow(temp, 'swap-1', 'transaction.mempool', { type: 'reverse', id: 'swap-1' })
    reconcilePendingIncoming(temp.db)
    expect(txRow(temp).state).toBe('pending')
  })

  test('orphaned swap_id (no boltz_swaps row) is skipped without wedging boot', () => {
    insertPendingTx(temp) // swap-1 referenced, never inserted
    expect(() => reconcilePendingIncoming(temp.db)).not.toThrow()
    expect(txRow(temp).state).toBe('pending')
  })

  test('sub-dust rows (NULL swap_id) are not reconcile material', () => {
    insertPendingTx(temp, { swapId: null }) // ln_receive's 30s reconciler owns these
    expect(() => reconcilePendingIncoming(temp.db)).not.toThrow()
    expect(txRow(temp).state).toBe('pending')
  })

  test('operator DM: settled fires exactly once across passes, failed stays silent', () => {
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
    reconcilePendingIncoming(temp.db, notify as never)
    expect(calls.length).toBe(1)
    expect(calls[0]!.kind).toBe('recv-ln')
    expect(calls[0]!.text).toContain('21 sats')

    // Second boot: the row is settled now — rows-changed gate keeps quiet.
    reconcilePendingIncoming(temp.db, notify as never)
    expect(calls.length).toBe(1)

    // A failure flip is unpaid-expiry noise — never DMed.
    insertPendingTx(temp, { swapId: 'swap-2' })
    insertSwapRow(temp, 'swap-2', 'swap.expired', { type: 'reverse', id: 'swap-2' })
    reconcilePendingIncoming(temp.db, notify as never)
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
