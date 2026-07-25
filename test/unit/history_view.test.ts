import { describe, expect, test } from 'bun:test'
import { historyView } from '../../src/web/views/history'
import type { HistoryRow } from '../../src/history'

const row = (over: Partial<HistoryRow>): HistoryRow => ({
  id: 1,
  kind: 'nwc_ln',
  direction: 'in',
  state: 'settled',
  amount_msat: 21_000,
  fees_msat: null,
  description: null,
  ref: 'r',
  txid: null,
  txid2: null,
  error: null,
  created_at: 1721900000,
  settled_at: 1721900001,
  ...over,
})

describe('historyView', () => {
  test('renders rows with sign, kind label, and escaped description', () => {
    const out = historyView({
      page: {
        rows: [
          row({ id: 2, direction: 'in', amount_msat: 21_000 }),
          row({
            id: 1,
            kind: 'ark_send',
            direction: 'out',
            state: 'failed',
            description: '<script>alert(1)</script>',
            error: 'boom',
          }),
        ],
        next: null,
      },
      isFirstPage: true,
    }).value
    expect(out).toContain('+21 sats')
    expect(out).toContain('−21 sats')
    expect(out).toContain('NWC · LN')
    expect(out).not.toContain('<script>alert(1)</script>') // escaped, not raw
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('Older »')
  })

  test('pager links carry the cursor and the latest link off the first page', () => {
    const out = historyView({
      page: { rows: [row({})], next: { createdAt: 1721900000, id: 1 } },
      isFirstPage: false,
    }).value
    expect(out).toContain('/history?before=1721900000-1')
    expect(out).toContain('« Latest')
  })

  test('empty states distinguish no-activity from end-of-pages', () => {
    const empty = { rows: [], next: null }
    expect(historyView({ page: empty, isFirstPage: true }).value).toContain('No activity recorded yet')
    expect(historyView({ page: empty, isFirstPage: false }).value).toContain('No older entries')
  })
})
