import type { Database } from 'bun:sqlite'
import { NetworkError, type ArkadeSwaps } from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'

import { NwcError } from '../lib/errors'
import { issueInvoice, type IssuedInvoice } from '../ln_receive'
import { msatsToSats, satsToMsats } from '../lib/msat'
import type { Connection } from '../nostr/connections'

export interface MakeInvoiceDeps {
  swaps: ArkadeSwaps
  db: Database
  conn: Connection
  eventId: string
  /** Ark wallet — sub-dust receives are paid out to its address by Boltz. */
  wallet: Wallet
  /** ASP (arkd) REST base — the atomic sub-dust receive needs server params. */
  arkServerUrl: string
  /** Boltz REST base (no /v2 suffix). */
  boltzApiUrl: string
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
  // reverse swap ≥ dust, boltz's non-atomic plain-invoice path below it. We
  // return the invoice immediately; the row stays pending until settlement
  // flips it — via onSwapCompleted → syncSwapToDb (boltz.ts) for the swap
  // branch, via reconcileSubdustReceives (no swap object → no settlement
  // event) for the sub-dust branch.
  let issued: IssuedInvoice
  try {
    issued = await issueInvoice(deps, { amountSats, description, descriptionHash })
  } catch (err) {
    if (err instanceof NetworkError) {
      const boltzMessage = (err.errorData as { error?: string } | undefined)?.error
      throw new NwcError('OTHER', `boltz rejected the request: ${boltzMessage ?? err.message}`)
    }
    throw err
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
      issued.kind === 'swap' ? issued.swapId : null,
      createdAt,
      issued.expiresAt,
    )

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
