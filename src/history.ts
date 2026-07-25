import type { Database } from 'bun:sqlite'

// Unified wallet history ledger (HISTORY_DESIGN.md). One row per money event
// across every rail the bridge itself executes or observes. What each kind
// uses as its `ref` (the per-kind dedup / sync key):
//
//   nwc_ln    transactions.request_event_id — syncHistoryFromSources mirrors
//             state/fees/settled_at from `transactions`, which stays the
//             source of truth for NWC rows
//   offboard  offboards.id (stringified)     — same mirror treatment
//   noffer    reverse-swap id (≥dust) or invoice payment hash (sub-dust);
//             inserted at settle time by the CLINK ack funnel, which retries
//             until its receipt publishes — ON CONFLICT DO NOTHING makes
//             those retries idempotent
//   web_ln    invoice payment hash
//   ark_send  ark txid on success, NULL on failure (no natural key)
//   onboard   funding outpoint "txid:vout"
//
// Everything here is display bookkeeping — no money path depends on a
// history row existing, so callers treat these as best-effort.

export type HistoryKind = 'nwc_ln' | 'web_ln' | 'noffer' | 'ark_send' | 'onboard' | 'offboard'
export type HistoryState = 'pending' | 'settled' | 'failed' | 'expired'

export interface HistoryRow {
  id: number
  kind: HistoryKind
  direction: 'in' | 'out'
  state: HistoryState
  amount_msat: number
  fees_msat: number | null
  description: string | null
  ref: string | null
  txid: string | null
  txid2: string | null
  error: string | null
  created_at: number
  settled_at: number | null
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

function insert(
  db: Database,
  row: {
    kind: HistoryKind
    direction: 'in' | 'out'
    state: HistoryState
    amountMsat: number
    feesMsat?: number | null
    description?: string | null
    ref?: string | null
    txid?: string | null
    error?: string | null
    createdAt?: number
    settledAt?: number | null
  },
): void {
  db.query(
    `INSERT INTO history (kind, direction, state, amount_msat, fees_msat, description, ref, txid, error, created_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, ref) DO NOTHING`,
  ).run(
    row.kind,
    row.direction,
    row.state,
    row.amountMsat,
    row.feesMsat ?? null,
    row.description ?? null,
    row.ref ?? null,
    row.txid ?? null,
    row.error ?? null,
    row.createdAt ?? nowSec(),
    row.settledAt ?? null,
  )
}

/** NWC pay_invoice / make_invoice, right after the `transactions` INSERT. */
export function recordNwcLn(
  db: Database,
  args: {
    direction: 'in' | 'out'
    requestEventId: string
    amountMsat: number
    feesMsat?: number | null
    description?: string | null
    createdAt: number
  },
): void {
  insert(db, {
    kind: 'nwc_ln',
    direction: args.direction,
    state: 'pending',
    amountMsat: args.amountMsat,
    feesMsat: args.feesMsat,
    description: args.description,
    ref: args.requestEventId,
    createdAt: args.createdAt,
  })
}

/**
 * CLINK noffer/zap receive — inserted settled, from the ack funnel
 * (sendOfferReceipt / sendSubdustAck). Those retry until the receipt
 * publishes; the (kind, ref) conflict clause absorbs the reruns.
 */
export function recordNofferReceive(
  db: Database,
  args: { ref: string; amountSats: number; feesMsat?: number | null; description?: string | null },
): void {
  const now = nowSec()
  insert(db, {
    kind: 'noffer',
    direction: 'in',
    state: 'settled',
    amountMsat: args.amountSats * 1000,
    feesMsat: args.feesMsat,
    description: args.description,
    ref: args.ref,
    createdAt: now,
    settledAt: now,
  })
}

/**
 * Web /send LN rail: pending before the (possibly minutes-long) await.
 * Upsert, not insert-or-ignore: retrying the same bolt11 after a failure is a
 * normal move, and one invoice should stay one row — the retry resets the
 * existing row to pending (latest attempt wins) instead of silently recording
 * nothing.
 */
export function recordWebLnPending(
  db: Database,
  args: { paymentHash: string; amountMsat: number; description?: string | null },
): void {
  db.query(
    `INSERT INTO history (kind, direction, state, amount_msat, description, ref, created_at)
     VALUES ('web_ln', 'out', 'pending', ?, ?, ?, ?)
     ON CONFLICT(kind, ref) DO UPDATE SET
       state = 'pending', error = NULL, settled_at = NULL, created_at = excluded.created_at`,
  ).run(args.amountMsat, args.description ?? null, args.paymentHash, nowSec())
}

export function settleWebLn(
  db: Database,
  paymentHash: string,
  args: { feesMsat: number; txid?: string | null },
): void {
  db.query(
    `UPDATE history SET state = 'settled', fees_msat = ?, txid = ?, settled_at = ?
     WHERE kind = 'web_ln' AND ref = ? AND state = 'pending'`,
  ).run(args.feesMsat, args.txid ?? null, nowSec(), paymentHash)
}

export function failWebLn(db: Database, paymentHash: string, error: string): void {
  db.query(
    `UPDATE history SET state = 'failed', error = ?, settled_at = ?
     WHERE kind = 'web_ln' AND ref = ? AND state = 'pending'`,
  ).run(error, nowSec(), paymentHash)
}

/** Web /send Ark rail — synchronous, so recorded only in its final state. */
export function recordArkSend(
  db: Database,
  args: { amountSats: number; destination: string } & (
    | { txid: string }
    | { error: string }
  ),
): void {
  const ok = 'txid' in args
  insert(db, {
    kind: 'ark_send',
    direction: 'out',
    state: ok ? 'settled' : 'failed',
    amountMsat: args.amountSats * 1000,
    feesMsat: ok ? 0 : null,
    description: args.destination,
    ref: ok ? args.txid : null,
    txid: ok ? args.txid : null,
    error: ok ? null : args.error,
    settledAt: nowSec(),
  })
}

/** Web /send onchain rail, right after the `offboards` INSERT. */
export function recordOffboard(
  db: Database,
  args: { offboardId: number; amountSat: number; feeSat: number; address: string; createdAt: number },
): void {
  insert(db, {
    kind: 'offboard',
    direction: 'out',
    state: 'pending',
    amountMsat: args.amountSat * 1000,
    feesMsat: args.feeSat * 1000,
    description: args.address,
    ref: String(args.offboardId),
    createdAt: args.createdAt,
  })
}

/** Boarding watcher: a fresh onchain deposit entered the boarding set. */
export function recordOnboardPending(
  db: Database,
  args: { txid: string; vout: number; amountSats: number },
): void {
  insert(db, {
    kind: 'onboard',
    direction: 'in',
    state: 'pending',
    amountMsat: args.amountSats * 1000,
    feesMsat: null,
    ref: `${args.txid}:${args.vout}`,
    txid: args.txid,
  })
}

/** Boarding watcher: the deposit left the boarding set (settled into a VTXO). */
export function settleOnboard(db: Database, ref: string, spendTxid: string | null): void {
  db.query(
    `UPDATE history SET state = 'settled', txid2 = COALESCE(?, txid2), settled_at = ?
     WHERE kind = 'onboard' AND ref = ? AND state = 'pending'`,
  ).run(spendTxid, nowSec(), ref)
}

/**
 * Re-sync mirrored kinds from their source tables. `transactions` and
 * `offboards` keep their own lifecycles (handler settles, boot reconcilers,
 * SDK listener, background offboard promise) — instead of pairing a history
 * UPDATE with each of those sites, the mirror is refreshed wholesale here:
 * idempotent, drift-free, and cheap at this table's scale. Run before every
 * /history read and from the periodic reconciler.
 */
export function syncHistoryFromSources(db: Database): void {
  db.query(
    `UPDATE history SET
       state = t.state,
       fees_msat = t.fees_paid_msat,
       error = t.error,
       settled_at = t.settled_at
     FROM transactions t
     WHERE history.kind = 'nwc_ln' AND history.ref = t.request_event_id
       AND (history.state <> t.state
            OR COALESCE(history.fees_msat, -1) <> COALESCE(t.fees_paid_msat, -1))`,
  ).run()
  db.query(
    `UPDATE history SET
       state = o.state,
       txid = o.ark_txid,
       error = o.error,
       settled_at = o.settled_at
     FROM offboards o
     WHERE history.kind = 'offboard' AND history.ref = CAST(o.id AS TEXT)
       AND (history.state <> o.state OR COALESCE(history.txid, '') <> COALESCE(o.ark_txid, ''))`,
  ).run()
}

/**
 * Boot pass: a web LN send interrupted by a restart has no reconciler of its
 * own (the swap itself resumes via the SwapManager / atomic resume — money
 * safety lives there), so its pending history row would strand forever.
 * Terminalize it with a pointer at /swaps, where the real outcome shows up.
 */
export function sweepInterruptedWebSends(db: Database): number {
  return db
    .query(
      `UPDATE history SET state = 'failed', error = 'interrupted by restart — see /swaps for the outcome', settled_at = ?
       WHERE kind = 'web_ln' AND state = 'pending'`,
    )
    .run(nowSec()).changes
}

export interface HistoryCursor {
  createdAt: number
  id: number
}

export interface HistoryPage {
  rows: HistoryRow[]
  /** Cursor for the next (older) page; null when this page reaches the end. */
  next: HistoryCursor | null
}

/**
 * Newest-first keyset pagination. Strictly "next page only": rows older than
 * the cursor position, ordered (created_at DESC, id DESC) — the id tiebreak
 * makes same-second rows stable across pages. Fetches limit+1 to learn
 * whether an older page exists without a COUNT.
 */
export function listHistoryPage(
  db: Database,
  opts: { before?: HistoryCursor; limit?: number } = {},
): HistoryPage {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const rows = opts.before
    ? db
        .query<HistoryRow, [number, number, number, number]>(
          `SELECT * FROM history
           WHERE created_at < ? OR (created_at = ? AND id < ?)
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(opts.before.createdAt, opts.before.createdAt, opts.before.id, limit + 1)
    : db
        .query<HistoryRow, [number]>(
          `SELECT * FROM history ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  return {
    rows: page,
    next: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
  }
}

/** "1721900000-42" ↔ cursor. Returns null for anything malformed. */
export function parseHistoryCursor(raw: string | null): HistoryCursor | null {
  if (!raw) return null
  const m = /^(\d{1,12})-(\d{1,12})$/.exec(raw)
  if (!m) return null
  return { createdAt: Number(m[1]), id: Number(m[2]) }
}

export function formatHistoryCursor(c: HistoryCursor): string {
  return `${c.createdAt}-${c.id}`
}
