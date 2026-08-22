import { describe, expect, test } from 'bun:test'
import { SwapDirection } from '../../src/atomic/params'
import {
  RECEIVE_STATES,
  SEND_STATES,
  assertTransition,
  canTransition,
  classifyResume,
  isTerminal,
  type AtomicSwapState,
} from '../../src/atomic/state'

const SEND = SwapDirection.Send
const RECEIVE = SwapDirection.Receive

describe('state machine — terminals', () => {
  test('send terminals', () => {
    for (const s of ['claimed', 'refunded', 'cancelled', 'failed'] as const) expect(isTerminal(SEND, s)).toBe(true)
    for (const s of ['init', 'funded', 'ln_inflight', 'refund_wait'] as const) expect(isTerminal(SEND, s)).toBe(false)
  })
  test('receive terminals', () => {
    for (const s of ['settled', 'refunded', 'failed'] as const) expect(isTerminal(RECEIVE, s)).toBe(true)
    for (const s of ['init', 'invoice_issued', 'funded', 'claimed', 'refund_wait'] as const)
      expect(isTerminal(RECEIVE, s)).toBe(false)
  })
})

describe('state machine — transitions', () => {
  test('send happy path init→funded→ln_inflight→claimed', () => {
    expect(canTransition(SEND, 'init', 'funded')).toBe(true)
    expect(canTransition(SEND, 'funded', 'ln_inflight')).toBe(true)
    expect(canTransition(SEND, 'ln_inflight', 'claimed')).toBe(true)
  })
  test('send refund path funded→refund_wait→refunded', () => {
    expect(canTransition(SEND, 'funded', 'refund_wait')).toBe(true)
    expect(canTransition(SEND, 'refund_wait', 'refunded')).toBe(true)
  })
  test('send cancel path is reachable from every pre-claim state', () => {
    // refund_wait especially: boltz only declares the pay terminally failed
    // after the row is already there, so a machine that forbade it forced the
    // full wait to T even though the cancel leaf was sitting right there.
    for (const s of ['init', 'funded', 'ln_inflight', 'refund_wait'] as const) {
      expect(canTransition(SEND, s, 'cancelled')).toBe(true)
    }
    expect(canTransition(SEND, 'claimed', 'cancelled')).toBe(false) // boltz already took a
  })
  test('receive happy path invoice_issued→funded→claimed→settled', () => {
    expect(canTransition(RECEIVE, 'invoice_issued', 'funded')).toBe(true)
    expect(canTransition(RECEIVE, 'funded', 'claimed')).toBe(true)
    expect(canTransition(RECEIVE, 'claimed', 'settled')).toBe(true)
  })

  test('rejects illegal jumps and any move out of a terminal', () => {
    expect(canTransition(SEND, 'init', 'claimed')).toBe(false) // skips funding
    expect(canTransition(SEND, 'claimed', 'refunded')).toBe(false) // out of terminal
    expect(canTransition(RECEIVE, 'settled', 'failed')).toBe(false)
    expect(() => assertTransition(SEND, 'init', 'claimed')).toThrow(/illegal send transition/)
  })

  test('unknown state throws', () => {
    expect(() => isTerminal(SEND, 'bogus' as AtomicSwapState)).toThrow(/unknown/)
  })

  test('every non-terminal state has at least one exit; terminals have none', () => {
    for (const s of SEND_STATES) expect(isTerminal(SEND, s)).toBe(!['init', 'funded', 'ln_inflight', 'refund_wait'].includes(s))
    for (const s of RECEIVE_STATES)
      expect(isTerminal(RECEIVE, s)).toBe(!['init', 'invoice_issued', 'funded', 'claimed', 'refund_wait'].includes(s))
  })
})

describe('boot resume classification', () => {
  const T = 1_000_000n

  test('send: refund_wait refunds once T elapses, cooperatively cancels before', () => {
    expect(classifyResume({ direction: SEND, state: 'refund_wait', refundLocktime: T, nowSecs: T + 1n })).toBe('refund')
    // Pre-T is the whole point of the cancel leaf: the LN pay already failed,
    // so there is no reason to sit on the funding until T.
    expect(classifyResume({ direction: SEND, state: 'refund_wait', refundLocktime: T, nowSecs: T - 1n })).toBe('cancel')
  })
  test('send: funded/ln_inflight poll before T, refund after T', () => {
    expect(classifyResume({ direction: SEND, state: 'funded', refundLocktime: T, nowSecs: T - 1n })).toBe('poll')
    expect(classifyResume({ direction: SEND, state: 'ln_inflight', refundLocktime: T, nowSecs: T + 1n })).toBe('refund')
  })
  test('receive: funded→retry_claim, claimed→retry_settle, refund_wait→wait_settle', () => {
    const base = { direction: RECEIVE, refundLocktime: T, nowSecs: T + 1n } as const
    expect(classifyResume({ ...base, state: 'funded' })).toBe('retry_claim')
    expect(classifyResume({ ...base, state: 'claimed' })).toBe('retry_settle')
    expect(classifyResume({ ...base, state: 'refund_wait' })).toBe('wait_settle')
  })
  test('terminal → none', () => {
    expect(classifyResume({ direction: SEND, state: 'claimed', refundLocktime: T, nowSecs: T })).toBe('none')
    expect(classifyResume({ direction: RECEIVE, state: 'settled', refundLocktime: T, nowSecs: T })).toBe('none')
  })
})
