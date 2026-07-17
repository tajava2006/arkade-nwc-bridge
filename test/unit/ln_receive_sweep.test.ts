import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteAtomicSwapRepository, SwapDirection } from '../../src/atomic'
import { sweepExpiredAtomicReceives } from '../../src/ln_receive'

// EXPIRY_GRACE_SECONDS = 15*60 in ln_receive; the sweep fails a receive only
// once now > invoice-expiry + grace.
const GRACE = 15 * 60
const NOW = 1_800_000_000

let db: Database
let repo: SqliteAtomicSwapRepository
beforeEach(() => {
  db = new Database(':memory:')
  SqliteAtomicSwapRepository.migrate(db)
  repo = new SqliteAtomicSwapRepository(db)
})
afterEach(() => db.close())

function receive(id: string, state: 'invoice_issued' | 'funded' | 'claimed'): void {
  repo.create({
    id,
    direction: SwapDirection.Receive,
    paymentHash: id.padEnd(64, '0'),
    state: 'invoice_issued',
    amount: 14,
    refundLocktime: 0,
    invoice: `lnbc-${id}`,
    preimage: 'ab'.repeat(32),
  })
  if (state === 'funded') repo.transition(id, 'funded')
  if (state === 'claimed') {
    repo.transition(id, 'funded')
    repo.transition(id, 'claimed')
  }
}

// the injected decoder maps our fake invoices to a fixed absolute expiry
const expiredLongAgo = () => NOW - GRACE - 10 // past grace
const expiresSoon = () => NOW - 10 // past invoice expiry but WITHIN grace

describe('sweepExpiredAtomicReceives', () => {
  test('fails a never-funded receive whose invoice expired past the grace', () => {
    receive('r-expired', 'invoice_issued')
    const swept = sweepExpiredAtomicReceives(db, NOW, expiredLongAgo)
    expect(swept).toEqual(['r-expired'])
    expect(repo.get('r-expired')?.state).toBe('failed')
  })

  test('leaves an invoice_issued receive still within the grace window', () => {
    receive('r-fresh', 'invoice_issued')
    expect(sweepExpiredAtomicReceives(db, NOW, expiresSoon)).toEqual([])
    expect(repo.get('r-fresh')?.state).toBe('invoice_issued')
  })

  test('never touches funded or claimed swaps (in-flight)', () => {
    receive('r-funded', 'funded')
    receive('r-claimed', 'claimed')
    expect(sweepExpiredAtomicReceives(db, NOW, expiredLongAgo)).toEqual([])
    expect(repo.get('r-funded')?.state).toBe('funded')
    expect(repo.get('r-claimed')?.state).toBe('claimed')
  })

  test('an undecodable invoice is left alone, not guessed', () => {
    receive('r-bad', 'invoice_issued')
    const throwing = () => { throw new Error('bad bolt11') }
    expect(sweepExpiredAtomicReceives(db, NOW, throwing)).toEqual([])
    expect(repo.get('r-bad')?.state).toBe('invoice_issued')
  })
})
