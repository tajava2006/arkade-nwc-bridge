import type { Database } from 'bun:sqlite'

/**
 * Budget renewal cycles are computed, never stored. The current window's
 * start is a pure function of (renewal, now), so there is no reset job, no
 * last-reset column, and nothing to catch up on after downtime — a bridge
 * that was off for a month wakes up already knowing where "this week"
 * starts. Boundaries are calendar-aligned in the host's local timezone
 * (midnight / Monday 00:00 / 1st 00:00): predictable for a human, at the
 * accepted cost that moving the host timezone moves the boundaries.
 */
export type BudgetRenewal = 'never' | 'daily' | 'weekly' | 'monthly'

export const BUDGET_RENEWALS: readonly BudgetRenewal[] = [
  'never',
  'daily',
  'weekly',
  'monthly',
]

export function parseBudgetRenewal(value: string): BudgetRenewal | null {
  return (BUDGET_RENEWALS as readonly string[]).includes(value)
    ? (value as BudgetRenewal)
    : null
}

/** Start of the current budget window, unix seconds. 'never' → 0 (all time). */
export function periodStartSec(renewal: BudgetRenewal, now: Date): number {
  if (renewal === 'never') return 0
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (renewal === 'weekly') {
    // ISO week: Monday 00:00. getDay() is 0=Sunday, so Sunday rolls back 6.
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  } else if (renewal === 'monthly') {
    d.setDate(1)
  }
  return Math.floor(d.getTime() / 1000)
}

/** Next window boundary, unix seconds. 'never' → null (no renewal). */
export function nextRenewalSec(renewal: BudgetRenewal, now: Date): number | null {
  if (renewal === 'never') return null
  const d = new Date(periodStartSec(renewal, now) * 1000)
  if (renewal === 'daily') d.setDate(d.getDate() + 1)
  else if (renewal === 'weekly') d.setDate(d.getDate() + 7)
  else d.setMonth(d.getMonth() + 1) // always from the 1st, so no clamping edge
  return Math.floor(d.getTime() / 1000)
}

/**
 * Spend committed against the connection's budget in the current window,
 * in msats. Budgets track actual wallet movement — amount (invoice nominal)
 * plus fees_paid once settled; a pending row's fee isn't known yet, so it
 * reserves the nominal only until settlement fills the fee in. Pending rows
 * are included so in-flight payments reserve budget.
 *
 * Two sources by renewal type, on purpose:
 *  - periodic: SUM over `transactions` from the computed window start. The
 *    scan is bounded by one cycle of rows.
 *  - 'never': the lifetime window would make that SUM grow without bound on
 *    a busy connection, so it reads the O(1) `spent_msat` counter instead
 *    (safe precisely because 'never' has no resets to interact with) plus
 *    the always-tiny pending slice.
 */
export function cycleSpentMsat(
  db: Database,
  conn: { id: number; budgetRenewal: BudgetRenewal },
  now: Date,
): number {
  if (conn.budgetRenewal === 'never') {
    // Counter read fresh from the DB, not from the caller's Connection
    // snapshot: another payment settling between snapshot load and this
    // call moves its msats from the pending sum into the counter, and a
    // stale snapshot would miss them on both sides.
    const counter = db
      .query<{ spent_msat: number }, [number]>(
        'SELECT spent_msat FROM connections WHERE id = ?',
      )
      .get(conn.id)
    const row = db
      .query<{ total: number }, [number]>(
        `SELECT COALESCE(SUM(amount_msat), 0) AS total FROM transactions
         WHERE connection_id = ? AND type = 'outgoing' AND state = 'pending'`,
      )
      .get(conn.id)
    return (counter?.spent_msat ?? 0) + (row?.total ?? 0)
  }

  const start = periodStartSec(conn.budgetRenewal, now)
  // amount_msat alone is the invoice nominal — the wallet movement a budget
  // guards needs the fee added back (NULL while pending → nominal-only
  // reservation, same as the 'never' path's pending slice).
  const row = db
    .query<{ total: number }, [number, number]>(
      `SELECT COALESCE(SUM(amount_msat + COALESCE(fees_paid_msat, 0)), 0) AS total
       FROM transactions
       WHERE connection_id = ? AND created_at >= ?
         AND type = 'outgoing' AND state IN ('pending', 'settled')`,
    )
    .get(conn.id, start)
  return row?.total ?? 0
}
