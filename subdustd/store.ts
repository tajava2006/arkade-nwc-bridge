import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { canServerTransition, initialState, type Direction, type ServerState } from './state.ts'

// Swap rows must survive a restart: presigs, preimage and state are what let a
// half-done swap still be claimed, refunded or settled.

interface Migration {
  version: number
  description: string
  sql: string
}

// Append-only. Never edit a shipped entry; add a new version that corrects it.
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'atomic sub-dust swaps (carried over from the Boltz fork model)',
    sql: `
      -- payment_hash is UNIQUE: one swap per invoice (dedup, F17 idempotent init
      -- reads it back). fee_sats and self_delay are frozen at init — the split
      -- the funder presigns is computed from them, so a config or arkd change
      -- between init and fund must not move them.
      CREATE TABLE swaps (
        id               TEXT    PRIMARY KEY,
        direction        TEXT    NOT NULL CHECK (direction IN ('send', 'receive')),
        payment_hash     TEXT    NOT NULL UNIQUE,
        state            TEXT    NOT NULL,
        amount           INTEGER NOT NULL,
        refund_locktime  INTEGER NOT NULL,
        user_pubkey      TEXT    NOT NULL,
        fee_sats         INTEGER NOT NULL DEFAULT 0,
        self_delay       TEXT,
        invoice          TEXT,
        funding_outpoint TEXT,
        presigs          TEXT,
        preimage         TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_swaps_direction_state ON swaps(direction, state);
    `,
  },
]

export interface SwapRow {
  id: string
  direction: Direction
  paymentHash: string
  state: ServerState
  amount: number
  refundLocktime: number
  userPubkey: string
  feeSats: number
  selfDelay: bigint | null
  invoice: string | null
  fundingOutpoint: string | null
  presigs: string | null
  preimage: string | null
  createdAt: number
  updatedAt: number
}

export interface NewSwap {
  id: string
  direction: Direction
  paymentHash: string
  amount: number
  refundLocktime: number
  userPubkey: string
  feeSats?: number
  selfDelay?: bigint
  invoice?: string
}

/** Fields a transition may set in the same atomic UPDATE as the state change. */
export type SwapUpdate = Partial<Pick<SwapRow, 'fundingOutpoint' | 'presigs' | 'preimage' | 'invoice'>>

export class DuplicatePaymentHash extends Error {}

const COLUMN: Record<keyof SwapUpdate, string> = {
  fundingOutpoint: 'funding_outpoint',
  presigs: 'presigs',
  preimage: 'preimage',
  invoice: 'invoice',
}

interface DbRow {
  id: string
  direction: Direction
  payment_hash: string
  state: ServerState
  amount: number
  refund_locktime: number
  user_pubkey: string
  fee_sats: number
  self_delay: string | null
  invoice: string | null
  funding_outpoint: string | null
  presigs: string | null
  preimage: string | null
  created_at: number
  updated_at: number
}

const fromDb = (r: DbRow): SwapRow => ({
  id: r.id,
  direction: r.direction,
  paymentHash: r.payment_hash,
  state: r.state,
  amount: r.amount,
  refundLocktime: r.refund_locktime,
  userPubkey: r.user_pubkey,
  feeSats: r.fee_sats,
  selfDelay: r.self_delay === null ? null : BigInt(r.self_delay),
  invoice: r.invoice,
  fundingOutpoint: r.funding_outpoint,
  presigs: r.presigs,
  preimage: r.preimage,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const nowSecs = () => Math.floor(Date.now() / 1000)

type Params = Record<string, string | number | bigint | boolean | null>

export class SwapStore {
  private constructor(readonly db: Database) {}

  static open(path: string): SwapStore {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path, { create: true, strict: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL
    )`)
    applyMigrations(db)
    return new SwapStore(db)
  }

  close(): void {
    this.db.close()
  }

  /** Throws `DuplicatePaymentHash` when the invoice already has a swap. */
  create(s: NewSwap): SwapRow {
    const now = nowSecs()
    try {
      this.db
        .query(
          `INSERT INTO swaps (id, direction, payment_hash, state, amount, refund_locktime, user_pubkey,
             fee_sats, self_delay, invoice, created_at, updated_at)
           VALUES ($id, $direction, $hash, $state, $amount, $T, $user, $fee, $delay, $invoice, $now, $now)`,
        )
        .run({
          id: s.id,
          direction: s.direction,
          hash: s.paymentHash,
          state: initialState(s.direction),
          amount: s.amount,
          T: s.refundLocktime,
          user: s.userPubkey,
          fee: s.feeSats ?? 0,
          delay: s.selfDelay === undefined ? null : s.selfDelay.toString(),
          invoice: s.invoice ?? null,
          now,
        })
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE constraint failed: swaps.payment_hash')) {
        throw new DuplicatePaymentHash(`payment hash ${s.paymentHash} already has a swap`)
      }
      throw e
    }
    return this.get(s.id)!
  }

  get(id: string): SwapRow | undefined {
    const r = this.db.query<DbRow, { id: string }>('SELECT * FROM swaps WHERE id = $id').get({ id })
    return r ? fromDb(r) : undefined
  }

  getByPaymentHash(paymentHash: string): SwapRow | undefined {
    const r = this.db.query<DbRow, { h: string }>('SELECT * FROM swaps WHERE payment_hash = $h').get({ h: paymentHash })
    return r ? fromDb(r) : undefined
  }

  list(direction: Direction, states: readonly ServerState[]): SwapRow[] {
    if (states.length === 0) return []
    const params: Params = { direction }
    const names = states.map((s, i) => {
      params[`s${i}`] = s
      return `$s${i}`
    })
    return this.db
      .query<DbRow, Params>(
        `SELECT * FROM swaps WHERE direction = $direction AND state IN (${names.join(', ')}) ORDER BY created_at, id`,
      )
      .all(params)
      .map(fromDb)
  }

  /**
   * Compare-and-set: moves the row to `to` only if it is still in `from`, in
   * one UPDATE, together with `fields`. Returns false when another caller got
   * there first — two concurrent /send/fund calls cannot both win (F3).
   * An edge the state machine forbids is a bug and throws.
   */
  transition(id: string, from: ServerState, to: ServerState, fields: SwapUpdate = {}): boolean {
    const row = this.get(id)
    if (!row) throw new Error(`unknown swap ${id}`)
    if (!canServerTransition(row.direction, from, to)) {
      throw new Error(`illegal ${row.direction} transition ${from} → ${to} for swap ${id}`)
    }
    const params: Params = { id, from, to, now: nowSecs() }
    const sets = ['state = $to', 'updated_at = $now']
    for (const [key, value] of Object.entries(fields) as [keyof SwapUpdate, string | null | undefined][]) {
      if (value === undefined) continue
      sets.push(`${COLUMN[key]} = $${key}`)
      params[key] = value
    }
    const res = this.db.query(`UPDATE swaps SET ${sets.join(', ')} WHERE id = $id AND state = $from`).run(params)
    return res.changes === 1
  }
}

function applyMigrations(db: Database): void {
  const applied = new Set(
    db.query<{ version: number }, []>('SELECT version FROM schema_migrations').all().map((r) => r.version),
  )
  const maxKnown = MIGRATIONS[MIGRATIONS.length - 1]!.version
  const maxApplied = Math.max(0, ...applied)
  if (maxApplied > maxKnown) {
    throw new Error(`subdustd database is schema v${maxApplied}, newer than this build (v${maxKnown}) — refusing a downgrade`)
  }
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    db.transaction(() => {
      db.exec(m.sql)
      db.query('INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.description,
        nowSecs(),
      )
    })()
  }
}
