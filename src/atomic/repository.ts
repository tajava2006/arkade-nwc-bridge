import type { Database } from 'bun:sqlite'
import { SwapDirection } from './params'
import { assertTransition, isTerminal, type AtomicSwapState } from './state'
import type { AtomicPresig } from './tx'

// Persistent store for in-flight atomic swaps (ATOMIC_SUBDUST_PLAN.md §3.4).
// Pre-signatures, the preimage, and swap state MUST survive a restart — losing
// them strands the swap (can't refund, can't settle). payment_hash is UNIQUE so
// the same invoice can't be swapped twice.

// The schema lives here so the migration (src/db.ts) and the in-memory unit
// tests apply the identical DDL. When the epic merges to main, fold this into a
// numbered append-only migration (plan §5).
export const ATOMIC_SWAPS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS atomic_swaps (
    id                TEXT    PRIMARY KEY,
    direction         TEXT    NOT NULL,          -- 'send' | 'receive'
    payment_hash      TEXT    NOT NULL UNIQUE,   -- H (hex) — invoice dedup
    state             TEXT    NOT NULL,
    amount            INTEGER NOT NULL,          -- a (sats)
    refund_locktime   INTEGER NOT NULL,          -- T (unix seconds)
    funding_outpoint  TEXT,                      -- 'txid:vout' once funded
    presigs_json      TEXT,                      -- send: F's 2 presigs (base64 PSBTs)
    preimage          TEXT,                      -- receive: our preimage (hex)
    invoice           TEXT,                      -- bolt11
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_atomic_swaps_state ON atomic_swaps(state);
`

export interface AtomicSwapRow {
  id: string
  direction: SwapDirection
  paymentHash: string
  state: AtomicSwapState
  amount: number
  refundLocktime: number
  fundingOutpoint?: string
  presigs?: AtomicPresig
  preimage?: string
  invoice?: string
  createdAt: number
  updatedAt: number
}

export interface NewAtomicSwap {
  id: string
  direction: SwapDirection
  paymentHash: string
  state: AtomicSwapState
  amount: number
  refundLocktime: number
  invoice?: string
  preimage?: string
}

export class DuplicateSwapError extends Error {
  constructor(paymentHash: string) {
    super(`atomic swap for payment hash ${paymentHash} already exists`)
    this.name = 'DuplicateSwapError'
  }
}

interface DbRow {
  id: string
  direction: string
  payment_hash: string
  state: string
  amount: number
  refund_locktime: number
  funding_outpoint: string | null
  presigs_json: string | null
  preimage: string | null
  invoice: string | null
  created_at: number
  updated_at: number
}

function fromDb(r: DbRow): AtomicSwapRow {
  return {
    id: r.id,
    direction: r.direction as SwapDirection,
    paymentHash: r.payment_hash,
    state: r.state as AtomicSwapState,
    amount: r.amount,
    refundLocktime: r.refund_locktime,
    fundingOutpoint: r.funding_outpoint ?? undefined,
    presigs: r.presigs_json ? (JSON.parse(r.presigs_json) as AtomicPresig) : undefined,
    preimage: r.preimage ?? undefined,
    invoice: r.invoice ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export class SqliteAtomicSwapRepository {
  readonly version = 1

  constructor(private readonly db: Database) {}

  /** Apply the schema (idempotent) — for tests / standalone setup. */
  static migrate(db: Database): void {
    db.run(ATOMIC_SWAPS_SCHEMA)
  }

  create(swap: NewAtomicSwap): AtomicSwapRow {
    const now = Date.now()
    try {
      this.db
        .query(
          `INSERT INTO atomic_swaps
             (id, direction, payment_hash, state, amount, refund_locktime, invoice, preimage, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          swap.id,
          swap.direction,
          swap.paymentHash,
          swap.state,
          swap.amount,
          swap.refundLocktime,
          swap.invoice ?? null,
          swap.preimage ?? null,
          now,
          now,
        )
    } catch (e) {
      if (e instanceof Error && /UNIQUE/.test(e.message)) throw new DuplicateSwapError(swap.paymentHash)
      throw e
    }
    return this.get(swap.id)!
  }

  get(id: string): AtomicSwapRow | undefined {
    const r = this.db.query('SELECT * FROM atomic_swaps WHERE id = ?').get(id) as DbRow | null
    return r ? fromDb(r) : undefined
  }

  getByPaymentHash(paymentHash: string): AtomicSwapRow | undefined {
    const r = this.db.query('SELECT * FROM atomic_swaps WHERE payment_hash = ?').get(paymentHash) as DbRow | null
    return r ? fromDb(r) : undefined
  }

  /** Non-terminal swaps to resume on boot. */
  listResumable(): AtomicSwapRow[] {
    return (this.db.query('SELECT * FROM atomic_swaps').all() as DbRow[])
      .map(fromDb)
      .filter((s) => !isTerminal(s.direction, s.state))
  }

  /** Move a swap to `to`, enforcing the state machine. Throws on illegal moves. */
  transition(id: string, to: AtomicSwapState): AtomicSwapRow {
    const cur = this.mustGet(id)
    assertTransition(cur.direction, cur.state, to)
    this.db.query('UPDATE atomic_swaps SET state = ?, updated_at = ? WHERE id = ?').run(to, Date.now(), id)
    return this.get(id)!
  }

  setFundingOutpoint(id: string, outpoint: string): void {
    this.touch(id, 'funding_outpoint', outpoint)
  }

  setPresigs(id: string, presigs: AtomicPresig): void {
    this.touch(id, 'presigs_json', JSON.stringify(presigs))
  }

  setPreimage(id: string, preimageHex: string): void {
    this.touch(id, 'preimage', preimageHex)
  }

  private touch(id: string, column: string, value: string): void {
    this.mustGet(id)
    this.db.query(`UPDATE atomic_swaps SET ${column} = ?, updated_at = ? WHERE id = ?`).run(value, Date.now(), id)
  }

  private mustGet(id: string): AtomicSwapRow {
    const row = this.get(id)
    if (!row) throw new Error(`atomic swap ${id} not found`)
    return row
  }
}
