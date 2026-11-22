import type { Database } from 'bun:sqlite'
import { decodeInvoice } from '../lib/bolt11'
import type { Wallet } from '@arkade-os/sdk'

import { cycleSpentMsat } from '../lib/budget'
import { NwcError } from '../lib/errors'
import { recordNwcLn } from '../history'
import { failOutgoing, settleOutgoing } from '../ln_ledger'
import { LnSendRefused, LnSendUnresolved, sendLightning, type LightningRails } from '../ln_send'
import { satsToMsats } from '../lib/msat'
import type { Connection } from '../nostr/connections'
import type { NotifyFn } from '../nostr/notifier'

export interface PayInvoiceDeps {
  /** Undefined when no Lightning rails are configured (Ark-only bridge). */
  lightning?: LightningRails
  db: Database
  conn: Connection
  eventId: string
  wallet: Wallet
  /** ASP (arkd) REST base — the atomic sub-dust send needs server params. */
  arkServerUrl: string
  /**
   * Operator DM sink, forwarded into sendLightning. Solver send terminals are
   * notified from the swap listener (ln_ledger.ts, single source), so this
   * handler itself never calls it — only the atomic sub-dust path underneath does.
   */
  notify?: NotifyFn
}

export async function handlePayInvoice(
  deps: PayInvoiceDeps,
  params: Record<string, unknown>,
): Promise<unknown> {
  const invoice = typeof params.invoice === 'string' ? params.invoice : null
  if (!invoice) {
    throw new NwcError('OTHER', 'invoice (bolt11) is required')
  }
  const lightning = deps.lightning
  if (!lightning) throw new NwcError('NOT_IMPLEMENTED', 'this wallet has no Lightning rail configured')

  let decoded
  try {
    decoded = decodeInvoice(invoice)
  } catch (err) {
    throw new NwcError('OTHER', `invalid BOLT11 invoice: ${(err as Error).message}`)
  }
  if (!decoded.amountSats || decoded.amountSats <= 0) {
    throw new NwcError('OTHER', '0-amount invoices are not supported (specify amount in invoice)')
  }
  const invoiceMsat = satsToMsats(decoded.amountSats)

  // M2: an already-settled payment for this hash must not re-fund a second swap.
  // LN itself refuses to double-settle a payment hash, but a retried request
  // would otherwise mint a fresh swap — burning the swap fee and locking the
  // funding for T. Replay the stored preimage instead.
  const settled = deps.db
    .query<{ preimage: string }, [string]>(
      `SELECT preimage FROM transactions WHERE type = 'outgoing' AND payment_hash = ? AND state = 'settled' LIMIT 1`,
    )
    .get(decoded.paymentHash)
  if (settled?.preimage) {
    return { preimage: settled.preimage }
  }
  // A payment for this hash still in flight on this connection — refuse rather
  // than run a concurrent second swap.
  const inFlight = deps.db
    .query<{ id: number }, [number, string]>(
      `SELECT id FROM transactions WHERE connection_id = ? AND type = 'outgoing' AND payment_hash = ? AND state = 'pending' LIMIT 1`,
    )
    .get(deps.conn.id, decoded.paymentHash)
  if (inFlight) {
    throw new NwcError('OTHER', 'an identical invoice is already being paid on this connection')
  }

  if (deps.conn.budgetMsat !== null) {
    // Recomputed here (not the dispatch-time Connection snapshot) and
    // pending-inclusive, with no await between this check and the INSERT
    // below — so concurrent payments can't jointly overshoot the budget:
    // the second request's sum always sees the first one's pending row.
    const spent = cycleSpentMsat(deps.db, deps.conn, new Date())
    if (spent + invoiceMsat > deps.conn.budgetMsat) {
      throw new NwcError('QUOTA_EXCEEDED', 'connection budget exceeded')
    }
  }

  const createdAt = Math.floor(Date.now() / 1000)
  deps.db
    .query(
      `INSERT INTO transactions (
         connection_id, type, request_event_id, invoice, payment_hash,
         amount_msat, state, created_at
       ) VALUES (?, 'outgoing', ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(deps.conn.id, deps.eventId, invoice, decoded.paymentHash, invoiceMsat, createdAt)
  // Wallet-level ledger twin of the row above. `transactions` stays the
  // source of truth; syncHistoryFromSources mirrors every later transition,
  // so none of the settle/fail sites below touch history directly.
  recordNwcLn(deps.db, {
    direction: 'out',
    requestEventId: deps.eventId,
    amountMsat: invoiceMsat,
    description: decoded.description || null,
    createdAt,
  })

  // sendLightning is the shared LN-send path (src/ln_send.ts): our solver for
  // amounts >= dust, the atomic sub-dust send below it. Both are atomic. Can
  // take minutes — bounded by the payment's own timeout, not by our code.
  let result
  try {
    result = await sendLightning(
      {
        lightning,
        wallet: deps.wallet,
        arkServerUrl: deps.arkServerUrl,
        db: deps.db,
        notify: deps.notify,
        // Link the row the instant the swap exists. Restart recovery would
        // still find an unlinked row by its payment hash; the link just keeps
        // a second connection's row for the same invoice out of the match.
        onSwapCreated: (swapId) => {
          deps.db
            .query(`UPDATE transactions SET swap_id = ? WHERE request_event_id = ? AND state = 'pending'`)
            .run(swapId, deps.eventId)
        },
      },
      invoice,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof LnSendUnresolved) {
      // The money may still move: the row keeps its reservation and stays
      // pending until the swap resolves (the ledger listener or the atomic
      // reconcile flips it). Retrying this invoice is refused meanwhile.
      throw new NwcError('INTERNAL', `${msg} — do not retry; the payment may still complete`)
    }
    failOutgoing(deps.db, { requestEventId: deps.eventId }, msg)
    if (err instanceof LnSendRefused && err.insufficientFunds) throw new NwcError('INSUFFICIENT_BALANCE', msg)
    throw new NwcError('PAYMENT_FAILED', msg)
  }

  // result.amount is what left the wallet (invoice + swap fee). amount_msat
  // keeps the invoice nominal written at INSERT — the number the payee
  // received — and the gap becomes fees_paid_msat: our cost, never part of
  // the amount.
  const feesPaidMsat = Math.max(0, satsToMsats(result.amount) - invoiceMsat)
  settleOutgoing(deps.db, { requestEventId: deps.eventId }, { preimage: result.preimage, paidSats: result.amount, swapId: result.swapId })

  return {
    preimage: result.preimage,
    fees_paid: feesPaidMsat > 0 ? feesPaidMsat : undefined,
  }
}
