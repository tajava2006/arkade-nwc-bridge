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
    throw new NwcError('OTHER', '0-amount invoices are not supported (specify amount in invoice)')
  }
  const invoiceMsat = satsToMsats(decoded.amountSats)

  if (deps.conn.budgetMsat !== null) {
    if (deps.conn.spentMsat + invoiceMsat > deps.conn.budgetMsat) {
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

  // sendLightningPayment is the one-shot submarine-swap path: it creates the
  // swap, sends the VTXO to the lockup address, waits for Boltz to settle
  // the LN side, and returns the preimage. On failure the SDK auto-refunds
  // via the SwapManager when possible. Can take minutes — bounded by
  // Boltz's LN payment timeout, not by our code.
  let result
  try {
    result = await deps.swaps.sendLightningPayment({ invoice })
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
  // on-Ark amount handed to the swap provider, i.e. invoice + swap fee.
  // That's the number that left the wallet, so promote it into amount_msat
  // on success (replacing the invoice-nominal value written at INSERT).
  const paidMsat = satsToMsats(result.amount)
  const feesPaidMsat = Math.max(0, paidMsat - invoiceMsat)
  const settledAt = Math.floor(Date.now() / 1000)

  deps.db
    .query(
      `UPDATE transactions SET state = 'settled', preimage = ?, amount_msat = ?, fees_paid_msat = ?, settled_at = ?
       WHERE request_event_id = ?`,
    )
    .run(result.preimage, paidMsat, feesPaidMsat, settledAt, deps.eventId)
  deps.db
    .query(`UPDATE connections SET spent_msat = spent_msat + ? WHERE id = ?`)
    .run(invoiceMsat, deps.conn.id)

  return {
    preimage: result.preimage,
    fees_paid: feesPaidMsat > 0 ? feesPaidMsat : undefined,
  }
}
