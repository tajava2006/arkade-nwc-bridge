import type { Database } from 'bun:sqlite'
import { NetworkError, decodeInvoice, type ArkadeSwaps } from '@arkade-os/boltz-swap'

import { NwcError } from '../lib/errors'
import { satsToMsats } from '../lib/msat'
import type { Connection } from '../nostr/connections'

export interface PayInvoiceDeps {
  swaps: ArkadeSwaps
  db: Database
  conn: Connection
  eventId: string
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
    // NIP-47 lets the client supply `params.amount` for 0-amount invoices,
    // but we don't honor that yet; reject explicitly rather than handing
    // Boltz an empty amount.
    throw new NwcError('OTHER', '0-amount invoices are not supported (specify amount in invoice)')
  }
  const invoiceMsat = satsToMsats(decoded.amountSats)

  // Budget enforcement. spent_msat is bumped only after a successful payment
  // below, so a parallel request can in principle race past the budget — that
  // tightens up to a SELECT-then-UPDATE reservation once the Web UI (phase 8)
  // actually lets the user set a budget.
  if (deps.conn.budgetMsat !== null) {
    if (deps.conn.spentMsat + invoiceMsat > deps.conn.budgetMsat) {
      throw new NwcError('QUOTA_EXCEEDED', 'connection budget exceeded')
    }
  }

  const createdAt = Math.floor(Date.now() / 1000)
  deps.db
    .query(
      `INSERT INTO payments (
         connection_id, request_event_id, invoice, payment_hash,
         amount_msat, state, created_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(deps.conn.id, deps.eventId, invoice, decoded.paymentHash, invoiceMsat, createdAt)

  // sendLightningPayment is the one-shot submarine-swap path: it creates
  // the swap, sends the VTXO to the lockup address, waits for Boltz to
  // settle the LN side, and returns the preimage. On failure the SDK
  // auto-refunds via the SwapManager when possible (see the d.ts annotation
  // "@throws TransactionFailedError (auto-refunds if possible)"), so we
  // don't need an explicit refund path here.
  //
  // The call can take minutes — bounded by Boltz's LN payment timeout, not
  // by our code. NWC clients have to be prepared for that.
  let result
  try {
    result = await deps.swaps.sendLightningPayment({ invoice })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.db
      .query(`UPDATE payments SET state = 'failed', error = ? WHERE request_event_id = ?`)
      .run(msg, deps.eventId)

    if (err instanceof NetworkError) {
      const boltzMessage = (err.errorData as { error?: string } | undefined)?.error
      throw new NwcError('PAYMENT_FAILED', `boltz: ${boltzMessage ?? err.message}`)
    }
    throw new NwcError('PAYMENT_FAILED', msg)
  }

  // SendLightningPaymentResponse.amount is documented as "Amount paid in
  // satoshis" — the on-Ark amount we handed Boltz, which equals the invoice
  // amount + Boltz fee. Subtracting the invoice amount yields fees in sats.
  const paidMsat = satsToMsats(result.amount)
  const feesPaidMsat = Math.max(0, paidMsat - invoiceMsat)
  const settledAt = Math.floor(Date.now() / 1000)

  deps.db
    .query(
      `UPDATE payments SET state = 'settled', preimage = ?, fees_paid_msat = ?, settled_at = ?
       WHERE request_event_id = ?`,
    )
    .run(result.preimage, feesPaidMsat, settledAt, deps.eventId)
  deps.db
    .query(`UPDATE connections SET spent_msat = spent_msat + ? WHERE id = ?`)
    .run(invoiceMsat, deps.conn.id)

  return {
    preimage: result.preimage,
    fees_paid: feesPaidMsat > 0 ? feesPaidMsat : undefined,
  }
}
