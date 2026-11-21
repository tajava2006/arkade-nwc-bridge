import { describe, expect, test } from 'bun:test'
import { classifyTrackResult, lnPaymentIsDead } from '../../subdustd/cancel_gate.ts'
import { LndError, type PaymentSnapshot, type TrackResult } from '../../subdustd/lnd/client.ts'

// F21 carried over from the Boltz fork: co-signing the funder's unwind gives
// back the coin we would claim from, so it may only happen when NO HTLC under
// the hash can still settle. The refusals are pinned as hard as the permissions.

const payment = (status: PaymentSnapshot['status'], htlcs: PaymentSnapshot['htlcs'] = []): TrackResult => ({
  found: true,
  payment: { status, htlcs, preimage: '', feeMsat: 0n, failureReason: '' },
})

describe('classifyTrackResult', () => {
  test('terminally failed with every attempt resolved → safe', () => {
    expect(classifyTrackResult(payment('FAILED', [{ status: 'FAILED' }, { status: 'FAILED' }]))).toEqual({
      dead: true,
      reason: 'payment terminally failed',
    })
    expect(classifyTrackResult(payment('FAILED')).dead).toBe(true)
  })

  test('LND has no payment for the hash → safe (nothing was ever sent)', () => {
    expect(classifyTrackResult({ found: false })).toEqual({ dead: true, reason: 'no LN payment was ever initiated' })
  })

  test('in flight, initiated, succeeded or unknown → refuse', () => {
    for (const status of ['IN_FLIGHT', 'INITIATED', 'SUCCEEDED', 'UNKNOWN'] as const) {
      const v = classifyTrackResult(payment(status))
      expect(v.dead).toBe(false)
      expect(v.reason).toContain(status)
    }
  })

  test('FAILED overall but an attempt still in flight → refuse', () => {
    const v = classifyTrackResult(payment('FAILED', [{ status: 'FAILED' }, { status: 'IN_FLIGHT' }]))
    expect(v).toEqual({ dead: false, reason: '1 HTLC attempt(s) still in flight' })
  })
})

describe('lnPaymentIsDead', () => {
  test('any throw refuses — unreachable, hung, or an error that merely looks like not-found', async () => {
    for (const err of [
      new LndError('TrackPaymentV2', 14, 'unavailable'),
      new LndError('TrackPaymentV2', 4, 'deadline exceeded'),
      new LndError('TrackPaymentV2', 5, 'not found'),
      new Error('socket hang up'),
    ]) {
      const v = await lnPaymentIsDead({ trackPayment: () => Promise.reject(err) }, 'aa'.repeat(32))
      expect(v).toEqual({ dead: false, reason: 'LND did not answer' })
    }
  })

  test('asks for a snapshot, never the blocking form', async () => {
    const calls: boolean[] = []
    await lnPaymentIsDead(
      {
        trackPayment: (_h, untilFinal = false) => {
          calls.push(untilFinal)
          return Promise.resolve({ found: false })
        },
      },
      'aa'.repeat(32),
    )
    expect(calls).toEqual([false])
  })
})
