import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  cycleSpentMsat,
  nextRenewalSec,
  parseBudgetRenewal,
  periodStartSec,
} from '../../src/lib/budget'
import { createConnection, type Connection } from '../../src/nostr/connections'
import { openTempDb, type TempDb } from '../helpers/db'

// Fixtures are built with the local-time Date constructor and compared
// against expectations built the same way, so the tests hold in any host
// timezone — which is the contract: boundaries are local-calendar-aligned.
const sec = (d: Date) => Math.floor(d.getTime() / 1000)

describe('periodStartSec / nextRenewalSec', () => {
  test('never: window starts at 0 and never renews', () => {
    const now = new Date(2026, 6, 15, 14, 30)
    expect(periodStartSec('never', now)).toBe(0)
    expect(nextRenewalSec('never', now)).toBeNull()
  })

  test('daily: local midnight, renews tomorrow', () => {
    const now = new Date(2026, 6, 15, 14, 30, 5)
    expect(periodStartSec('daily', now)).toBe(sec(new Date(2026, 6, 15)))
    expect(nextRenewalSec('daily', now)).toBe(sec(new Date(2026, 6, 16)))
    // exactly at the boundary the new window has just started
    expect(periodStartSec('daily', new Date(2026, 6, 15))).toBe(sec(new Date(2026, 6, 15)))
  })

  test('weekly: Monday 00:00, Sunday rolls back six days', () => {
    // 2026-07-13 is a Monday.
    const wednesday = new Date(2026, 6, 15, 9)
    const sunday = new Date(2026, 6, 19, 23, 59)
    const mondayItself = new Date(2026, 6, 13, 5)
    const monday = sec(new Date(2026, 6, 13))
    expect(periodStartSec('weekly', wednesday)).toBe(monday)
    expect(periodStartSec('weekly', sunday)).toBe(monday)
    expect(periodStartSec('weekly', mondayItself)).toBe(monday)
    expect(nextRenewalSec('weekly', wednesday)).toBe(sec(new Date(2026, 6, 20)))
  })

  test('monthly: the 1st 00:00, including 31-day and leap-February ends', () => {
    expect(periodStartSec('monthly', new Date(2026, 6, 31, 23, 59, 59))).toBe(
      sec(new Date(2026, 6, 1)),
    )
    expect(nextRenewalSec('monthly', new Date(2026, 6, 31, 23, 59, 59))).toBe(
      sec(new Date(2026, 7, 1)),
    )
    expect(nextRenewalSec('monthly', new Date(2026, 0, 31))).toBe(sec(new Date(2026, 1, 1)))
    // 2028 is a leap year
    expect(periodStartSec('monthly', new Date(2028, 1, 29, 12))).toBe(sec(new Date(2028, 1, 1)))
    expect(nextRenewalSec('monthly', new Date(2028, 1, 29, 12))).toBe(sec(new Date(2028, 2, 1)))
  })
})

describe('parseBudgetRenewal', () => {
  test('accepts the four renewals, rejects everything else', () => {
    expect(parseBudgetRenewal('never')).toBe('never')
    expect(parseBudgetRenewal('daily')).toBe('daily')
    expect(parseBudgetRenewal('weekly')).toBe('weekly')
    expect(parseBudgetRenewal('monthly')).toBe('monthly')
    expect(parseBudgetRenewal('hourly')).toBeNull()
    expect(parseBudgetRenewal('')).toBeNull()
    expect(parseBudgetRenewal('DAILY')).toBeNull()
  })
})

describe('cycleSpentMsat', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  let seq = 0
  function insertTx(
    connId: number,
    args: { type: 'incoming' | 'outgoing'; state: string; amountMsat: number; createdAt: number },
  ): void {
    temp.db
      .query(
        `INSERT INTO transactions (
           connection_id, type, request_event_id, invoice, payment_hash,
           amount_msat, state, created_at
         ) VALUES (?, ?, ?, 'lnbc1', 'hash', ?, ?, ?)`,
      )
      .run(connId, args.type, `evt-${++seq}`, args.amountMsat, args.state, args.createdAt)
  }

  function conn(budgetRenewal: Connection['budgetRenewal']): Connection {
    return createConnection(temp.db, {
      label: null,
      relays: ['wss://r'],
      budgetMsat: 10_000_000,
      budgetRenewal,
    }).connection
  }

  test("never: reads the counter plus pending rows; settled rows don't double-count", () => {
    const c = conn('never')
    temp.db.query('UPDATE connections SET spent_msat = ? WHERE id = ?').run(5_000_000, c.id)
    const now = new Date(2026, 6, 15, 12)
    // settled history is already inside the counter — must not be re-added
    insertTx(c.id, { type: 'outgoing', state: 'settled', amountMsat: 5_000_000, createdAt: sec(now) - 60 })
    insertTx(c.id, { type: 'outgoing', state: 'pending', amountMsat: 1_000_000, createdAt: sec(now) })
    expect(cycleSpentMsat(temp.db, c, now)).toBe(6_000_000)
  })

  test('daily: sums only outgoing pending+settled rows inside the current window', () => {
    const c = conn('daily')
    const now = new Date(2026, 6, 15, 12)
    const today = sec(new Date(2026, 6, 15, 9))
    const twoDaysAgo = sec(new Date(2026, 6, 13, 9))
    insertTx(c.id, { type: 'outgoing', state: 'settled', amountMsat: 2_000_000, createdAt: twoDaysAgo })
    insertTx(c.id, { type: 'outgoing', state: 'settled', amountMsat: 1_500_000, createdAt: today })
    insertTx(c.id, { type: 'outgoing', state: 'pending', amountMsat: 500_000, createdAt: today })
    insertTx(c.id, { type: 'outgoing', state: 'failed', amountMsat: 700_000, createdAt: today })
    insertTx(c.id, { type: 'incoming', state: 'settled', amountMsat: 900_000, createdAt: today })
    // stale counter must be irrelevant on the periodic path
    temp.db.query('UPDATE connections SET spent_msat = ? WHERE id = ?').run(9_999_999, c.id)
    expect(cycleSpentMsat(temp.db, c, now)).toBe(2_000_000)
  })
})
