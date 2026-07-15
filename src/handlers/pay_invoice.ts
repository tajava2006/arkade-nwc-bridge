import type { Database } from 'bun:sqlite'
import { NetworkError, decodeInvoice, type ArkadeSwaps } from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'

import { cycleSpentMsat } from '../lib/budget'
import { NwcError } from '../lib/errors'
import { sendLightning } from '../ln_send'
import { satsToMsats } from '../lib/msat'
import type { Connection } from '../nostr/connections'

export interface PayInvoiceDeps {
  swaps: ArkadeSwaps
  db: Database
  conn: Connection
  eventId: string
  /** Ark wallet — sub-dust sends fund an atomic shared vtxo (atomic_send.ts). */
  wallet: Wallet
  /** Boltz REST base (no /v2 suffix). */
  boltzApiUrl: string
  /** ASP (arkd) REST base — the atomic sub-dust send needs server params. */
  arkServerUrl: string
}

export async function handlePayInvoice(
  deps: PayInvoiceDeps,
  params: Record<string, unknown>,
): Promise<unknown> {
  const invoice = typeof params.invoice === 'string' ? params.invoice : null
  if (!invoice) {
    throw new NwcError('OTHER', 'invoice (bolt11) is required')
  }

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

  // sendLightning is the shared LN-send path (src/ln_send.ts): a Boltz
  // submarine swap for amounts >= dust, or boltz's non-atomic plain-send for
  // sub-dust (where a submarine swap can't settle). Can take minutes — bounded
  // by Boltz's LN payment timeout, not by our code.
  let result
  try {
    result = await sendLightning(deps, invoice)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.db
      .query(`UPDATE transactions SET state = 'failed', error = ? WHERE request_event_id = ?`)
      .run(msg, deps.eventId)

    if (err instanceof NetworkError) {
      const boltzMessage = (err.errorData as { error?: string } | undefined)?.error
      throw new NwcError('PAYMENT_FAILED', `boltz: ${boltzMessage ?? err.message}`)
    }
    throw new NwcError('PAYMENT_FAILED', msg)
  }

  // SendLightningPaymentResponse.amount is "Amount paid in satoshis" — the
  // on-Ark total handed to the swap provider (invoice + swap fee + any drain
  // residue). amount_msat keeps the invoice nominal written at INSERT — the
  // number the payee received — and the whole gap becomes fees_paid_msat:
  // our cost of the send, never part of the amount. What left the wallet is
  // derived as amount + fees, not stored.
  const paidMsat = satsToMsats(result.amount)
  const feesPaidMsat = Math.max(0, paidMsat - invoiceMsat)
  const settledAt = Math.floor(Date.now() / 1000)

  // One transaction: the 'never' budget path reads counter + pending rows,
  // so flipping the row out of 'pending' and bumping the counter must be
  // atomic — a crash in between would release the pending reservation
  // without ever landing it in the counter, permanently under-counting the
  // payment. The counter adds paidMsat (wallet movement, fee included) —
  // amount + fees of the settled row.
  deps.db.transaction(() => {
    deps.db
      .query(
        `UPDATE transactions SET state = 'settled', preimage = ?, fees_paid_msat = ?, settled_at = ?
         WHERE request_event_id = ?`,
      )
      .run(result.preimage, feesPaidMsat, settledAt, deps.eventId)
    deps.db
      .query(`UPDATE connections SET spent_msat = spent_msat + ? WHERE id = ?`)
      .run(paidMsat, deps.conn.id)
  })()

  return {
    preimage: result.preimage,
    fees_paid: feesPaidMsat > 0 ? feesPaidMsat : undefined,
  }
}
