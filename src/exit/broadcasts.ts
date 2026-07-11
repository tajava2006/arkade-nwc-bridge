import type { Database } from 'bun:sqlite'

// When a broadcast entered the mempool, keyed by the broadcast txid (v15
// migration — see db.ts for why this is the only recorded fact). Read by the
// boost UI to say "waiting N blocks"; never load-bearing — a missing row just
// hides the counter.

export interface ExitBroadcast {
  stepTxid: string
  txid: string
  vout: number
  tipHeight: number | null
  createdAt: number
}

interface Row {
  step_txid: string
  txid: string
  vout: number
  tip_height: number | null
  created_at: number
}

const rowToBroadcast = (r: Row): ExitBroadcast => ({
  stepTxid: r.step_txid,
  txid: r.txid,
  vout: r.vout,
  tipHeight: r.tip_height,
  createdAt: r.created_at,
})

/**
 * Upsert the broadcast record. Overwriting tip_height on re-broadcast is
 * intended: after a mempool eviction the wait starts over. Pass tipHeight
 * explicitly (a sweep RBF carries the OLD row's height forward — the wait
 * began at the first broadcast, not at the replacement).
 */
export function recordBroadcast(
  db: Database,
  stepTxid: string,
  txid: string,
  vout: number,
  tipHeight: number | null,
): void {
  db.query(
    `INSERT INTO exit_broadcasts (step_txid, txid, vout, tip_height, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(step_txid) DO UPDATE SET tip_height = excluded.tip_height`,
  ).run(stepTxid, txid, vout, tipHeight, Math.floor(Date.now() / 1000))
}

export function getBroadcast(db: Database, stepTxid: string): ExitBroadcast | null {
  const row = db
    .query<Row, [string]>(`SELECT * FROM exit_broadcasts WHERE step_txid = ?`)
    .get(stepTxid)
  return row ? rowToBroadcast(row) : null
}
