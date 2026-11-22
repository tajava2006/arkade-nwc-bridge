import type { Database } from 'bun:sqlite'
import type { Wallet } from '@arkade-os/sdk'

import { NwcError } from '../lib/errors'
import { recordNwcLn } from '../history'
import { issueInvoice, type IssuedInvoice } from '../ln_receive'
import type { LightningRails } from '../ln_send'
import { msatsToSats, satsToMsats } from '../lib/msat'
import type { Connection } from '../nostr/connections'

export interface MakeInvoiceDeps {
  /** Undefined when no Lightning rails are configured (Ark-only bridge). Receives use subdustd. */
  lightning?: Pick<LightningRails, 'subdustdUrl'>
  db: Database
  conn: Connection
  eventId: string
  /** Ark wallet — the receive is claimed to its address. */
  wallet: Wallet
  /** ASP (arkd) REST base — the claim needs server params. */
  arkServerUrl: string
}

export async function handleMakeInvoice(
  deps: MakeInvoiceDeps,
  params: Record<string, unknown>,
): Promise<unknown> {
  const amountMsat = typeof params.amount === 'number' ? params.amount : NaN
  if (!Number.isFinite(amountMsat) || amountMsat <= 0) {
    throw new NwcError('OTHER', 'amount (msat) must be a positive integer')
  }

  const { sats: amountSats, exact } = msatsToSats(amountMsat)
  if (!exact) {
    throw new NwcError('OTHER', 'amount must be a whole number of sats (multiple of 1000 msat)')
  }

  const description = typeof params.description === 'string' ? params.description : undefined
  const descriptionHash =
    typeof params.description_hash === 'string' ? params.description_hash : undefined
  if (descriptionHash !== undefined && !/^[0-9a-f]{64}$/i.test(descriptionHash)) {
    throw new NwcError('OTHER', 'description_hash must be a 32-byte hex SHA256')
  }

  // issueInvoice (src/ln_receive.ts) is the shared LN-receive core: a Boltz
  // reverse swap ≥ dust, the atomic sub-dust receive below it. We return the
  // invoice immediately; the row stays pending until settlement flips it —
  // via onSwapCompleted → syncSwapToDb (boltz.ts) for the swap branch, via
  // reconcileAtomicReceives (no swap object → no settlement event) for the
  // sub-dust branch.
  if (!deps.lightning) throw new NwcError('NOT_IMPLEMENTED', 'this wallet has no Lightning rail configured')
  let issued: IssuedInvoice
  try {
    issued = await issueInvoice(
      { wallet: deps.wallet, subdustdUrl: deps.lightning.subdustdUrl, arkServerUrl: deps.arkServerUrl, db: deps.db },
      { amountSats, description, descriptionHash },
    )
  } catch (err) {
    // subdustd refuses what it cannot fund right now (503) rather than hold a
    // payer's HTLC it would have to cancel.
    throw new NwcError('OTHER', `cannot issue an invoice right now: ${err instanceof Error ? err.message : String(err)}`)
  }

  const createdAt = Math.floor(Date.now() / 1000)

  // amount_msat is the BOLT11 nominal — exactly what the client asked for and
  // what the payer pays (the invoice is never inflated: NIP-57 receipt
  // validation demands the bolt11 amount match the zap request). The swap
  // provider's cut comes out of what lands on Ark — moving LN → Ark is the
  // receiver's cost, never the payer's — and is recorded as fees_paid_msat;
  // the actual credit is derived as amount − fees, not stored.
  const receivedMsat = satsToMsats(issued.receivedSats)
  const feesPaidMsat = Math.max(0, amountMsat - receivedMsat)

  deps.db
    .query(
      `INSERT INTO transactions (
         connection_id, type, request_event_id, invoice, payment_hash,
         amount_msat, fees_paid_msat, description, swap_id, state, created_at, expires_at
       ) VALUES (?, 'incoming', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      deps.conn.id,
      deps.eventId,
      issued.invoice,
      issued.paymentHash,
      amountMsat,
      feesPaidMsat,
      description ?? null,
      // NULL: atomic receives match their row by payment hash (reconcileAtomicReceives).
      null,
      createdAt,
      issued.expiresAt,
    )
  // Wallet-level ledger twin — state transitions (settle / expire) are
  // mirrored from `transactions` by syncHistoryFromSources, never here.
  recordNwcLn(deps.db, {
    direction: 'in',
    requestEventId: deps.eventId,
    amountMsat,
    feesMsat: feesPaidMsat,
    description: description ?? null,
    createdAt,
  })

  return {
    type: 'incoming',
    state: 'pending',
    invoice: issued.invoice,
    description,
    description_hash: descriptionHash,
    payment_hash: issued.paymentHash,
    amount: amountMsat,
    fees_paid: feesPaidMsat > 0 ? feesPaidMsat : undefined,
    created_at: createdAt,
    expires_at: issued.expiresAt,
  }
}
