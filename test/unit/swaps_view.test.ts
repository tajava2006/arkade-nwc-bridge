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
  test('refund button appears only past T + blocktime lag, for a non-terminal send', () => {
    const nowSec = 1752603600 + 3600 + 10 // past T + blocktime lag (arkd's real gate)
    const eligible = swap({ id: 'refundable', state: 'refund_wait', fundingOutpoint: 'f'.repeat(64) + ':0' })
    const terminal = swap({ id: 'done', state: 'claimed', fundingOutpoint: 'f'.repeat(64) + ':0' })
    const receive = swap({ id: 'rcv', direction: SwapDirection.Receive, state: 'funded', fundingOutpoint: 'f'.repeat(64) + ':0' })
    const html = swapsView({ swaps: [eligible, terminal, receive], nowSec }).value
    // exactly one refund form — the eligible send
    expect(html.split('/swaps/refund').length - 1).toBe(1)
    expect(html).toContain('refundable')
  })

  test('past wall-T but within the blocktime lag → NO lever (arkd would reject)', () => {
    // the exact live-mainnet footgun: wall clock passed T, but blocktime (MTP)
    // hasn't, so a refund would bounce with FORFEIT_CLOSURE_LOCKED. The button
    // must stay hidden until T + lag.
    const nowSec = 1752603600 + 600 // 10m past T, well inside the ~1h lag
    const html = swapsView({
      swaps: [swap({ state: 'refund_wait', fundingOutpoint: 'f'.repeat(64) + ':0' })],
      nowSec,
    }).value
    expect(html).not.toContain('/swaps/refund')
  })

  test('pre-T send shows a countdown (to T + lag), no refund lever', () => {
    const nowSec = 1752603600 - 90 // before T
    const html = swapsView({
      swaps: [swap({ fundingOutpoint: 'f'.repeat(64) + ':0' })],
      nowSec,
    }).value
    expect(html).not.toContain('/swaps/refund')
    expect(html).toContain('in 1h') // counts toward T + 1h lag
  })

  test('receive rows show "— (boltz)" for refund T, never a garbage countdown', () => {
    // receive swaps store refundLocktime=0 (T is boltz's); it must not render
    // as a "…h ago" countdown.
    const html = swapsView({
      swaps: [swap({ direction: SwapDirection.Receive, state: 'settled', refundLocktime: 0 })],
      nowSec: 1752603600,
    }).value
    expect(html).toContain('— (boltz)')
    expect(html).not.toContain('ago')
  })

  test('notice renders', () => {
    const html = swapsView({ swaps: [], nowSec: 0, notice: { ok: true, text: 'refunded 351 sats' } }).value
    expect(html).toContain('refunded 351 sats')
  })
})
