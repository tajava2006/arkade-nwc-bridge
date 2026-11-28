import type { LndClient, PaymentSnapshot, TrackResult } from './lnd/client.ts'

// The safety gate for the atomic sub-dust cooperative cancel
// (ATOMIC_SUBDUST_PLAN.md §11). Co-signing the funder's unwind hands back the
// coin we would have claimed from, so it may only happen once NO HTLC under
// that payment hash can still settle. Wrong in the permissive direction, we
// pay the invoice and lose the funding — the one way the swap stops being
// atomic for the server.

export interface CancelVerdict {
  /** true ⇒ no HTLC can settle any more; safe to co-sign the cancel. */
  dead: boolean
  reason: string
}

/**
 * Exactly two answers are safe: LND has no record of the hash (nothing was
 * ever sent), or the payment is terminally FAILED with no attempt in flight.
 * IN_FLIGHT, INITIATED, SUCCEEDED and the deprecated UNKNOWN all refuse.
 */
export const classifyTrackResult = (result: TrackResult): CancelVerdict => {
  if (!result.found) return { dead: true, reason: 'no LN payment was ever initiated' }
  return classifyPayment(result.payment)
}

const classifyPayment = (payment: Pick<PaymentSnapshot, 'status' | 'htlcs'>): CancelVerdict => {
  if (payment.status !== 'FAILED') return { dead: false, reason: `payment is ${payment.status}` }
  // LND only marks a payment FAILED once every attempt resolved, so this should
  // be vacuous — the swap's atomicity rests on it, so verify, don't trust.
  const live = payment.htlcs.filter((h) => h.status === 'IN_FLIGHT').length
  if (live > 0) return { dead: false, reason: `${live} HTLC attempt(s) still in flight` }
  return { dead: true, reason: 'payment terminally failed' }
}

/**
 * Snapshot, not the blocking form: waiting for a terminal status would hang the
 * request for as long as a live HTLC does — the very case to answer "no" to.
 * A throw (LND down, hung past the deadline, any error) refuses: not knowing a
 * payment is dead is not knowing it is dead. NOT_FOUND never throws — the
 * client turns it into `found: false`.
 */
export const lnPaymentIsDead = async (
  lnd: Pick<LndClient, 'trackPayment'>,
  paymentHash: string,
): Promise<CancelVerdict> => {
  try {
    return classifyTrackResult(await lnd.trackPayment(paymentHash, false))
  } catch {
    return { dead: false, reason: 'LND did not answer' }
  }
}
