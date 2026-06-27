import type { Database } from 'bun:sqlite'
import { NetworkError, decodeInvoice, type ArkadeSwaps } from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'

import { NwcError } from '../lib/errors'
import { satsToMsats } from '../lib/msat'
import type { Connection } from '../nostr/connections'

// Below P2TR dust a submarine swap can't settle (the vHTLC lockup vtxo is
// sub-dust → arkd VTXO_RECOVERABLE → claim strands), so sub-dust sends take
// boltz's non-atomic plain-send path instead. See sendSubdust below.
const DUST_SATS = 330

export interface PayInvoiceDeps {
  swaps: ArkadeSwaps
  db: Database
  conn: Connection
  eventId: string
  /** Ark wallet — sub-dust sends move a plain vtxo to boltz directly. */
  wallet: Wallet
  /** Boltz REST base (no /v2 suffix). */
  boltzApiUrl: string
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
    result =
      decoded.amountSats < DUST_SATS
        ? await sendSubdust(deps, invoice, decoded.amountSats)
        : await deps.swaps.sendLightningPayment({ invoice })
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

/**
 * Sub-dust ARK->LN send via boltz's non-atomic plain-send path (server side:
 * patches/boltz-subdust-api.patch, POST /v2/subdust/send). Instead of a
 * submarine swap — which can't settle below dust because the vHTLC lockup vtxo
 * is sub-dust (arkd VTXO_RECOVERABLE → claim strands) — we move a plain vtxo of
 * (invoice + fee) to boltz's ARK address and ask boltz to pay. No vHTLC, so no
 * swept-vtxo DB garbage and the send shows up as a normal vtxo (audit trail).
 *
 * Non-atomic: we move the vtxo first, trusting boltz to pay. Boltz dedups on the
 * arkTxid (its DB PK), so the funding tx can fund at most one payment — a replay
 * can't double-pay. Mirrors the receive direction (see SUBDUST_LN_PATCH.md).
 * Returns the same shape as sendLightningPayment ({ amount, preimage }).
 */
async function sendSubdust(
  deps: PayInvoiceDeps,
  invoice: string,
  invoiceSats: number,
): Promise<{ amount: number; preimage: string }> {
  // Match what a normal submarine swap would charge so boltz still collects its
  // fee; boltz absorbs any routing over that. (Miner/fixed fee not added here —
  // a refinement; for sub-dust it's negligible and boltz's check is `>= invoice`.)
  const fees = await deps.swaps.getFees()
  const feeSats = Math.ceil((invoiceSats * fees.submarine.percentage) / 100)
  const sendSats = invoiceSats + feeSats

  const { address } = await subdustFetch<{ address: string }>(
    `${deps.boltzApiUrl}/v2/subdust/address`,
  )
  const arkTxid = await deps.wallet.send({ address, amount: sendSats })

  const { preimage } = await subdustFetch<{ paid: boolean; preimage: string }>(
    `${deps.boltzApiUrl}/v2/subdust/send`,
    { arkTxid, invoice },
  )
  return { amount: sendSats, preimage }
}

async function subdustFetch<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as T
}
