import type { Database } from 'bun:sqlite'

// Durable intent records for unilateral exits (v11 migration). Coarse on
// purpose: fine-grained unroll progress is re-derived from chain state on
// every run, so these rows only answer "which vtxos did the operator decide
// to exit, and roughly where are they" across restarts.

export type ExitOpState = 'unrolling' | 'waiting' | 'sweepable' | 'swept' | 'failed'

export interface ExitOp {
  txid: string
  vout: number
  state: ExitOpState
  destAddress: string | null
  sweepTxid: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

interface Row {
  txid: string
  vout: number
  state: ExitOpState
  dest_address: string | null
  sweep_txid: string | null
  error: string | null
  created_at: number
  updated_at: number
}

const rowToOp = (r: Row): ExitOp => ({
  txid: r.txid,
  vout: r.vout,
  state: r.state,
  destAddress: r.dest_address,
  sweepTxid: r.sweep_txid,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export function createOrRestartExitOp(db: Database, txid: string, vout: number): ExitOp {
  const now = Math.floor(Date.now() / 1000)
  const row = db
    .query<Row, [string, number, number, number]>(
      `INSERT INTO exit_ops (txid, vout, state, created_at, updated_at)
       VALUES (?, ?, 'unrolling', ?, ?)
       ON CONFLICT(txid, vout) DO UPDATE SET
         state = 'unrolling',
         error = NULL,
         updated_at = excluded.updated_at
       RETURNING *`,
    )
    .get(txid, vout, now, now)
  if (!row) throw new Error('failed to upsert exit op')
  return rowToOp(row)
}

export function setExitOpState(
  db: Database,
  txid: string,
  vout: number,
  state: ExitOpState,
  extra: { error?: string; sweepTxid?: string; destAddress?: string } = {},
): void {
  db.query(
    `UPDATE exit_ops
     SET state = ?, error = ?, sweep_txid = COALESCE(?, sweep_txid),
         dest_address = COALESCE(?, dest_address), updated_at = ?
     WHERE txid = ? AND vout = ?`,
  ).run(
    state,
    extra.error ?? null,
    extra.sweepTxid ?? null,
    extra.destAddress ?? null,
    Math.floor(Date.now() / 1000),
    txid,
    vout,
  )
}

export function getExitOp(db: Database, txid: string, vout: number): ExitOp | null {
  const row = db
    .query<Row, [string, number]>(`SELECT * FROM exit_ops WHERE txid = ? AND vout = ?`)
    .get(txid, vout)
  return row ? rowToOp(row) : null
}

/** Every op settled by one (possibly batched) sweep tx — an RBF replaces it for all of them at once. */
export function listOpsBySweepTxid(db: Database, sweepTxid: string): ExitOp[] {
  return db
    .query<Row, [string]>(`SELECT * FROM exit_ops WHERE sweep_txid = ? ORDER BY txid, vout`)
    .all(sweepTxid)
    .map(rowToOp)
}

export function listExitOps(db: Database, states?: ExitOpState[]): ExitOp[] {
  if (!states || states.length === 0) {
    return db
      .query<Row, []>(`SELECT * FROM exit_ops ORDER BY created_at, txid, vout`)
      .all()
      .map(rowToOp)
  }
  const marks = states.map(() => '?').join(',')
  return db
    .query<Row, ExitOpState[]>(
      `SELECT * FROM exit_ops WHERE state IN (${marks}) ORDER BY created_at, txid, vout`,
    )
    .all(...states)
    .map(rowToOp)
}
