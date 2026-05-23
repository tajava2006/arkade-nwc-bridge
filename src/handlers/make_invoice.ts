import type { Database } from 'bun:sqlite'
import { NetworkError, type ArkadeSwaps } from '@arkade-os/boltz-swap'

import { NwcError } from '../lib/errors'
import { msatsToSats, satsToMsats } from '../lib/msat'
import type { Connection } from '../nostr/connections'

export interface MakeInvoiceDeps {
  swaps: ArkadeSwaps
  db: Database
  conn: Connection
  eventId: string
}

export async function handleMakeInvoice(
  deps: MakeInvoiceDeps,
  params: Record<string, unknown>,
): Promise<unknown> {
  const amountMsat = typeof params.amount === 'number' ? params.amount : NaN
  if (!Number.isFinite(amountMsat) || amountMsat <= 0) {
    throw new NwcError('OTHER', 'amount (msat) must be a positive integer')
  }

  const { sats: amountSat, exact } = msatsToSats(amountMsat)
  if (!exact) {
    throw new NwcError('OTHER', 'amount must be a whole number of sats (multiple of 1000 msat)')
  }

  const description = typeof params.description === 'string' ? params.description : undefined

  // Reverse swap: Boltz issues a BOLT11 invoice we hand to the client. When
  // the LN side gets paid, Boltz lands a VHTLC on our swap address and the
  // SwapManager auto-claims it into our Ark wallet. We just return the
  // invoice immediately; the row stays pending until the manager's
  // onSwapCompleted listener flips it to settled.
  let result
  try {
    result = await deps.swaps.createLightningInvoice({
      amount: amountSat,
      description,
    })
  } catch (err) {
    if (err instanceof NetworkError) {
      const boltzMessage = (err.errorData as { error?: string } | undefined)?.error
      throw new NwcError('OTHER', `boltz rejected the request: ${boltzMessage ?? err.message}`)
    }
    throw err
  }

  const createdAt = Math.floor(Date.now() / 1000)
  const expiresAt = result.expiry

  // result.amount is the on-Ark amount after the swap provider's fee — what
  // will actually land in the wallet. amount_msat captures wallet movement,
  // fees_paid_msat captures the gap to the invoice nominal.
  const receivedMsat = satsToMsats(result.amount)
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
      result.invoice,
      result.paymentHash,
      receivedMsat,
      feesPaidMsat,
      description ?? null,
      result.pendingSwap.id,
      createdAt,
      expiresAt,
    )

  return {
    type: 'incoming',
    state: 'pending',
    invoice: result.invoice,
    description,
    payment_hash: result.paymentHash,
    amount: receivedMsat,
    fees_paid: feesPaidMsat > 0 ? feesPaidMsat : undefined,
    created_at: createdAt,
    expires_at: expiresAt,
  }
}
