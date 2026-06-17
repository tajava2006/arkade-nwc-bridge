import type { Database } from 'bun:sqlite'

// Durable record of bridge-native collaborative exits (onchain sends). See the
// v5 migration in db.ts for *why* this is separate from `transactions`. The web
// POST inserts a 'pending' row, fires Ramps.offboard without awaiting, and the
// background promise flips the row to 'settled' (with the commitment txid) or
// 'failed' (with the error). The send page renders recent rows and live-updates
// them over SSE.

export type OffboardState = 'pending' | 'settled' | 'failed'

export interface OffboardRow {
  id: number
  address: string
  amount_sat: number
  fee_sat: number
  is_max: number
  state: OffboardState
  ark_txid: string | null
  error: string | null
  created_at: number
  settled_at: number | null
}

export function createOffboard(
  db: Database,
  args: { address: string; amountSat: number; feeSat: number; isMax: boolean },
): OffboardRow {
  const createdAt = Math.floor(Date.now() / 1000)
  const row = db
    .query<OffboardRow, [string, number, number, number, number]>(
      `INSERT INTO offboards (address, amount_sat, fee_sat, is_max, state, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)
       RETURNING *`,
    )
    .get(args.address, args.amountSat, args.feeSat, args.isMax ? 1 : 0, createdAt)
  if (!row) throw new Error('failed to insert offboard row')
  return row
}

export function markOffboardSettled(db: Database, id: number, arkTxid: string): void {
  db.query(
    `UPDATE offboards SET state = 'settled', ark_txid = ?, settled_at = ? WHERE id = ?`,
  ).run(arkTxid, Math.floor(Date.now() / 1000), id)
}

export function markOffboardFailed(db: Database, id: number, error: string): void {
  db.query(
    `UPDATE offboards SET state = 'failed', error = ?, settled_at = ? WHERE id = ?`,
  ).run(error, Math.floor(Date.now() / 1000), id)
}

export function listRecentOffboards(db: Database, limit = 20): OffboardRow[] {
  return db
    .query<OffboardRow, [number]>(
      `SELECT * FROM offboards ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(limit)
}

export function hasPendingOffboards(db: Database): boolean {
  const row = db
    .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM offboards WHERE state = 'pending'`)
    .get()
  return (row?.c ?? 0) > 0
}
