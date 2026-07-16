import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SwapDirection } from '../../src/atomic/params'
import {
  DuplicateSwapError,
  SqliteAtomicSwapRepository,
  type NewAtomicSwap,
} from '../../src/atomic/repository'

function newSend(id: string, paymentHash: string): NewAtomicSwap {
  return { id, direction: SwapDirection.Send, paymentHash, state: 'init', amount: 21, refundLocktime: 1_000_000 }
}
function newReceive(id: string, paymentHash: string): NewAtomicSwap {
  return {
    id,
    direction: SwapDirection.Receive,
    paymentHash,
    state: 'init',
    amount: 21,
    refundLocktime: 1_000_000,
    preimage: 'ab'.repeat(32),
    invoice: 'lnbc…',
  }
}

let db: Database
let repo: SqliteAtomicSwapRepository

beforeEach(() => {
  db = new Database(':memory:')
  SqliteAtomicSwapRepository.migrate(db)
  repo = new SqliteAtomicSwapRepository(db)
})

describe('create + read', () => {
  test('round-trips a swap and finds it by id and payment hash', () => {
    const created = repo.create(newSend('s1', 'aa'.repeat(32)))
    expect(created.state).toBe('init')
    expect(repo.get('s1')?.paymentHash).toBe('aa'.repeat(32))
    expect(repo.getByPaymentHash('aa'.repeat(32))?.id).toBe('s1')
    expect(repo.get('missing')).toBeUndefined()
  })

  test('receive swap persists preimage + invoice', () => {
    repo.create(newReceive('r1', 'bb'.repeat(32)))
    const row = repo.get('r1')!
    expect(row.direction).toBe(SwapDirection.Receive)
    expect(row.preimage).toBe('ab'.repeat(32))
    expect(row.invoice).toBe('lnbc…')
  })

  test('duplicate payment hash is rejected', () => {
    repo.create(newSend('s1', 'cc'.repeat(32)))
    expect(() => repo.create(newSend('s2', 'cc'.repeat(32)))).toThrow(DuplicateSwapError)
  })
})

describe('transitions enforce the state machine', () => {
  test('legal transitions advance state', () => {
    repo.create(newSend('s1', 'dd'.repeat(32)))
    expect(repo.transition('s1', 'funded').state).toBe('funded')
    expect(repo.transition('s1', 'ln_inflight').state).toBe('ln_inflight')
    expect(repo.transition('s1', 'claimed').state).toBe('claimed')
  })

  test('illegal transition throws and does not mutate', () => {
    repo.create(newSend('s1', 'ee'.repeat(32)))
    expect(() => repo.transition('s1', 'claimed')).toThrow(/illegal send transition/)
    expect(repo.get('s1')?.state).toBe('init')
  })
})

describe('setters', () => {
  test('funding outpoint, presigs, preimage persist', () => {
    repo.create(newSend('s1', 'ff'.repeat(32)))
    repo.setFundingOutpoint('s1', 'abcd:0')
    repo.setPresigs('s1', { arkTx: 'AA', checkpoint: 'BB' })
    expect(repo.get('s1')?.fundingOutpoint).toBe('abcd:0')
    expect(repo.get('s1')?.presigs).toEqual({ arkTx: 'AA', checkpoint: 'BB' })
  })
})

describe('listResumable', () => {
  test('returns only non-terminal swaps', () => {
    repo.create(newSend('s1', '11'.repeat(32))) // init — resumable
    repo.create(newSend('s2', '22'.repeat(32)))
    repo.transition('s2', 'funded') // funded — resumable
    repo.create(newSend('s3', '33'.repeat(32)))
    repo.transition('s3', 'cancelled') // terminal — excluded
    repo.create(newReceive('r1', '44'.repeat(32)))
    repo.transition('r1', 'invoice_issued')
    repo.transition('r1', 'funded')
    repo.transition('r1', 'claimed')
    repo.transition('r1', 'settled') // terminal — excluded

    const ids = repo
      .listResumable()
      .map((s) => s.id)
      .sort()
    expect(ids).toEqual(['s1', 's2'])
  })
})

describe('script-rebuild params + dashboard listing (#13)', () => {
  test('peerPubkey/exitDelay round-trip (absent stays undefined)', () => {
    repo.create({ ...newSend('s-meta', 'a1'.repeat(32)), peerPubkey: 'cd'.repeat(32), exitDelay: 512 })
    const row = repo.get('s-meta')!
    expect(row.peerPubkey).toBe('cd'.repeat(32))
    expect(row.exitDelay).toBe(512)

    repo.create(newSend('s-bare', 'a2'.repeat(32)))
    expect(repo.get('s-bare')!.peerPubkey).toBeUndefined()
    expect(repo.get('s-bare')!.exitDelay).toBeUndefined()
  })

  test('list() returns newest-first and honors the limit', () => {
    repo.create(newSend('s-1', 'b1'.repeat(32)))
    repo.create(newSend('s-2', 'b2'.repeat(32)))
    repo.create(newSend('s-3', 'b3'.repeat(32)))
    const all = repo.list()
    expect(all.length).toBe(3)
    // same-ms creations tie-break on id; newest-first overall
    expect(all.map((s) => s.id).sort()).toEqual(['s-1', 's-2', 's-3'])
    expect(all[0]!.createdAt).toBeGreaterThanOrEqual(all[2]!.createdAt)
    expect(repo.list(2).length).toBe(2)
  })
})
