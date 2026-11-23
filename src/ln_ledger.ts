import type { Database } from 'bun:sqlite'
import { SqliteAtomicSwapRepository, SwapDirection } from './atomic'

// The NWC ledger side of Lightning sends. Two writers can settle the same
// outgoing row — the pay_invoice handler when its await returns, and the
// atomic reconcile below for a send whose handler never came back (restart,
// "unresolved"). Both are gated on `state = 'pending'`, so whichever lands
// first wins and the other is a no-op.

type OutgoingMatch = { requestEventId: string }

const matchSql = (m: OutgoingMatch): [string, string[]] => ['request_event_id = ?', [m.requestEventId]]

/**
 * Flip a pending outgoing row to settled and book it against the connection's
 * 'never' budget counter, in one transaction (the pending reservation and the
 * counter must hand over atomically). `paidSats` is what left the wallet; the
 * row's amount stays the invoice nominal and the gap is fees_paid. Returns
 * whether THIS call flipped a row.
 */
export function settleOutgoing(
  db: Database,
  match: OutgoingMatch,
  r: { preimage: string; paidSats: number; swapId: string },
): boolean {
  const [where, args] = matchSql(match)
  const now = Math.floor(Date.now() / 1000)
  return db.transaction(() => {
    const rows = db
      .query<{ id: number; connection_id: number; amount_msat: number }, string[]>(
        `SELECT id, connection_id, amount_msat FROM transactions WHERE type = 'outgoing' AND state = 'pending' AND ${where}`,
      )
      .all(...args)
    let flipped = false
    for (const row of rows) {
      const paidMsat = Math.max(r.paidSats * 1000, row.amount_msat)
      const res = db
        .query(
          `UPDATE transactions SET state = 'settled', preimage = ?, fees_paid_msat = ?, settled_at = ?, swap_id = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(r.preimage, paidMsat - row.amount_msat, now, r.swapId, row.id)
      if (res.changes > 0) {
        db.query(`UPDATE connections SET spent_msat = spent_msat + ? WHERE id = ?`).run(paidMsat, row.connection_id)
        flipped = true
      }
    }
    return flipped
  })()
}

export function failOutgoing(db: Database, match: OutgoingMatch, error: string): boolean {
  const [where, args] = matchSql(match)
  return (
    db
      .query(
        `UPDATE transactions SET state = 'failed', error = COALESCE(error, ?), settled_at = COALESCE(settled_at, ?)
         WHERE type = 'outgoing' AND state = 'pending' AND ${where}`,
      )
      .run(error, Math.floor(Date.now() / 1000), ...args).changes > 0
  )
}

/**
 * Crash-window reconcile for atomic sends (M1/R2): an atomic send whose NWC
 * row is still pending — the handler never returned (restart), or answered
 * "unresolved" — settles or fails from the atomic swap row, matched by payment
 * hash.
 *
 * R2: the settle books the reserved principal (amount_msat) into the 'never'
 * budget counter in the same transaction as the flip, changes-gated so a
 * re-entrant pass never double-counts.
 */
export function reconcileAtomicSendRows(db: Database): void {
  const now = Math.floor(Date.now() / 1000)
  const outgoing = db
    .query<{ id: number; payment_hash: string; amount_msat: number }, []>(
      `SELECT id, payment_hash, amount_msat FROM transactions WHERE type = 'outgoing' AND state = 'pending'`,
    )
    .all()
  const repo = new SqliteAtomicSwapRepository(db)
  for (const row of outgoing) {
    const atomic = repo.getByPaymentHash(row.payment_hash)
    if (!atomic || atomic.direction !== SwapDirection.Send) continue
    if (atomic.state === 'claimed') {
      db.transaction(() => {
        const res = db
          .query(
            `UPDATE transactions SET state = 'settled', preimage = COALESCE(preimage, ?), settled_at = ?,
                    fees_paid_msat = COALESCE(fees_paid_msat, 0)
             WHERE id = ? AND state = 'pending'`,
          )
          .run(atomic.preimage ?? null, now, row.id)
        if (res.changes > 0) {
          db.query(
            `UPDATE connections SET spent_msat = spent_msat + ?
             WHERE id = (SELECT connection_id FROM transactions WHERE id = ?)`,
          ).run(row.amount_msat, row.id)
        }
      })()
    } else if (atomic.state === 'refunded' || atomic.state === 'failed' || atomic.state === 'cancelled') {
      db.query(`UPDATE transactions SET state = 'failed', settled_at = ? WHERE id = ? AND state = 'pending'`).run(now, row.id)
    }
    // non-terminal → still in flight, leave pending
  }
}
