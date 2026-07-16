import { describe, expect, test } from 'bun:test'
import { swapsView } from '../../src/web/views/swaps'
import { SwapDirection } from '../../src/atomic'
import type { AtomicSwapRow } from '../../src/atomic'

const base = {
  paymentHash: 'ab'.repeat(32),
  amount: 21,
  createdAt: 1752600000000,
  updatedAt: 1752600000000,
}

function swap(over: Partial<AtomicSwapRow>): AtomicSwapRow {
  return {
    id: 'swap-xyz',
    direction: SwapDirection.Send,
    state: 'funded',
    refundLocktime: 1752603600,
    ...base,
    ...over,
  } as AtomicSwapRow
}

describe('swapsView', () => {
  test('refund button appears only for a T-elapsed non-terminal send with funding', () => {
    const nowSec = 1752603600 + 10 // past T
    const eligible = swap({ id: 'refundable', state: 'refund_wait', fundingOutpoint: 'f'.repeat(64) + ':0' })
    const terminal = swap({ id: 'done', state: 'claimed', fundingOutpoint: 'f'.repeat(64) + ':0' })
    const receive = swap({ id: 'rcv', direction: SwapDirection.Receive, state: 'funded', fundingOutpoint: 'f'.repeat(64) + ':0' })
    const html = swapsView({ swaps: [eligible, terminal, receive], nowSec }).value
    // exactly one refund form — the eligible send
    expect(html.split('/swaps/refund').length - 1).toBe(1)
    expect(html).toContain('refundable')
  })

  test('pre-T send shows a countdown, no refund lever', () => {
    const nowSec = 1752603600 - 90 // 1m30s before T
    const html = swapsView({
      swaps: [swap({ fundingOutpoint: 'f'.repeat(64) + ':0' })],
      nowSec,
    }).value
    expect(html).not.toContain('/swaps/refund')
    expect(html).toContain('in 1m 30s')
  })

  test('notice renders', () => {
    const html = swapsView({ swaps: [], nowSec: 0, notice: { ok: true, text: 'refunded 351 sats' } }).value
    expect(html).toContain('refunded 351 sats')
  })
})
