import type { Database } from 'bun:sqlite'
import type { Swap } from '@arkade-os/swap'
import { paidPreimage, type LnSendDeps } from './ln_send'
import type { NotifyFn } from './nostr/notifier'

// The NWC ledger side of solver swaps. Two writers can settle the same
// outgoing row — the pay_invoice handler when its await returns, and the
// swap listener below for a send whose handler never came back (restart,
// timeout). Both go through settleOutgoing, gated on `state = 'pending'`, so
// whichever lands first wins and the other is a no-op.

type OutgoingMatch = { requestEventId: string } | { swapId: string; paymentHash: string }

const matchSql = (m: OutgoingMatch): [string, string[]] =>
  'requestEventId' in m
    ? ['request_event_id = ?', [m.requestEventId]]
    : // A row linked to this swap, or — a crash before the link was written —
      // an unlinked row for this payment hash: the hash is the exact binding.
      ['(swap_id = ? OR (swap_id IS NULL AND payment_hash = ?))', [m.swapId, m.paymentHash]]

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

const isSend = (s: Swap) => s.route.take.corridor === 'lightning'
const sats = (s: Swap, leg: 'give' | 'take' | 'fee') => Number(s[leg].amount)

/**
 * Mirror solver sends into the NWC ledger and the operator DMs. Subscribed
 * after the client's restore read, so the client's synchronous replay of every
 * known swap runs inside the subscribe call: those updates settle rows a
 * restart left pending, but DM only when they actually flipped one (an old
 * terminal swap replays at every boot). Live transitions arrive once per
 * (swap, outcome) and always DM — this is the one owning site for send DMs.
 */
export function watchSolverSends(deps: Pick<LnSendDeps, 'lightning' | 'arkServerUrl' | 'db'> & { notify?: NotifyFn }): () => void {
  const { db, notify } = deps
  let replaying = true
  const onSwap = async (swap: Swap, replay: boolean) => {
    const hash = swap.lock?.hash
    if (!isSend(swap) || !hash) return
    const match = { swapId: swap.id, paymentHash: hash }
    const tag = `[swap ${swap.id.slice(4, 12)}]`
    if (swap.outcome === 'paid') {
      const preimage = await paidPreimage(deps, swap, hash)
      const flipped = settleOutgoing(db, match, { preimage, paidSats: sats(swap, 'give'), swapId: swap.id })
      if (flipped || !replay) {
        notify?.('send-ln', () => `send: LN paid — ${sats(swap, 'take')} sats (+${sats(swap, 'give') - sats(swap, 'take')} fee) ${tag}`)
      }
    } else if (swap.outcome === 'refunded' || swap.outcome === 'failed' || swap.outcome === 'cancelled') {
      const flipped = failOutgoing(db, match, `${swap.outcome}${swap.failure ? `: ${swap.failure}` : ''}`)
      if (flipped || !replay) {
        notify?.('send-fail', () => `send: LN payment FAILED — ${sats(swap, 'take')} sats (${swap.outcome}) ${tag}`)
        if (swap.outcome === 'refunded') notify?.('refund', () => `send: solver lockup refunded to wallet ${tag}`)
      }
    } else if (swap.outcome === 'needs_recovery' && !replay) {
      notify?.('send-fail', () => `send: LN payment needs recovery — ${swap.blockedReason ?? 'see /swaps'} ${tag}`)
    }
  }
  const unsubscribe = deps.lightning.solver.client.onUpdate(({ swap }) => {
    const replay = replaying
    onSwap(swap, replay).catch((e) => console.warn(`ln: ledger update for ${swap.id} failed: ${(e as Error).message}`))
  })
  replaying = false
  return unsubscribe
}
