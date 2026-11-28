import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canServerTransition, isServerTerminal } from '../../subdustd/state.ts'
import { DuplicatePaymentHash, SwapStore, type NewSwap } from '../../subdustd/store.ts'

const hash = (n: number) => n.toString(16).padStart(64, '0')
const send = (n: number, o: Partial<NewSwap> = {}): NewSwap => ({
  id: `s${n}`,
  direction: 'send',
  paymentHash: hash(n),
  amount: 21,
  refundLocktime: 1_900_000_000,
  userPubkey: 'aa'.repeat(32),
  ...o,
})
const receive = (n: number): NewSwap => ({ ...send(n), id: `r${n}`, direction: 'receive', invoice: 'lnbcrt1…' })

describe('server state machine', () => {
  test('the two edges where the server differs from the bridge', () => {
    // receive: the user claims, we only settle — no server-side `claimed`.
    expect(canServerTransition('receive', 'funded', 'settled')).toBe(true)
    // send: a terminally failed LN pay still awaits the funder's cancel (F21).
    expect(canServerTransition('send', 'failed', 'cancelled')).toBe(true)
    expect(isServerTerminal('send', 'failed')).toBe(false)
  })

  test('a paid send can never be unwound, and terminal states have no exits', () => {
    expect(canServerTransition('send', 'claimed', 'cancelled')).toBe(false)
    for (const s of ['claimed', 'cancelled'] as const) expect(isServerTerminal('send', s)).toBe(true)
    for (const s of ['settled', 'refunded', 'failed'] as const) expect(isServerTerminal('receive', s)).toBe(true)
  })

  test('failed never leads to claimed (only a returned FAILED gets there — F25)', () => {
    expect(canServerTransition('send', 'failed', 'claimed')).toBe(false)
    expect(canServerTransition('send', 'ln_inflight', 'claimed')).toBe(true)
    expect(canServerTransition('send', 'ln_inflight', 'failed')).toBe(true)
  })

  test('unknown states throw instead of reading as "not allowed"', () => {
    expect(() => canServerTransition('send', 'invoice_issued', 'funded')).toThrow('unknown send state')
    expect(() => canServerTransition('receive', 'funded', 'claimed')).toThrow('unknown receive state')
  })
})

describe('SwapStore', () => {
  test('create starts each direction in its initial state and round-trips every field', () => {
    const store = SwapStore.open(':memory:')
    const s = store.create(send(1, { feeSats: 1, selfDelay: 86_016n }))
    expect(s).toMatchObject({ state: 'init', direction: 'send', feeSats: 1, selfDelay: 86_016n, presigs: null })
    expect(store.create(receive(2)).state).toBe('invoice_issued')
    expect(store.getByPaymentHash(hash(1))?.id).toBe('s1')
    expect(store.get('nope')).toBeUndefined()
  })

  test('a second swap for the same invoice is refused', () => {
    const store = SwapStore.open(':memory:')
    store.create(send(1))
    expect(() => store.create({ ...send(1), id: 'other' })).toThrow(DuplicatePaymentHash)
  })

  test('transition is a compare-and-set that carries its fields atomically', () => {
    const store = SwapStore.open(':memory:')
    store.create(send(1))
    expect(store.transition('s1', 'init', 'funded', { fundingOutpoint: 'ff:0', presigs: '{"a":1}' })).toBe(true)
    expect(store.get('s1')).toMatchObject({ state: 'funded', fundingOutpoint: 'ff:0', presigs: '{"a":1}' })
    // A duplicate /send/fund loses the race instead of paying twice (F3).
    expect(store.transition('s1', 'init', 'funded', { fundingOutpoint: 'ee:0' })).toBe(false)
    expect(store.get('s1')?.fundingOutpoint).toBe('ff:0')
  })

  test('an edge the machine forbids throws, and leaves the row alone', () => {
    const store = SwapStore.open(':memory:')
    store.create(send(1))
    expect(() => store.transition('s1', 'init', 'claimed', { preimage: '11'.repeat(32) })).toThrow('illegal send transition')
    expect(store.get('s1')).toMatchObject({ state: 'init', preimage: null })
  })

  test('list filters by direction and state, oldest first', () => {
    const store = SwapStore.open(':memory:')
    store.create(send(1))
    store.create(send(2))
    store.create(receive(3))
    store.transition('s2', 'init', 'funded')
    expect(store.list('send', ['init', 'funded']).map((s) => s.id)).toEqual(['s1', 's2'])
    expect(store.list('send', ['funded']).map((s) => s.id)).toEqual(['s2'])
    expect(store.list('receive', ['invoice_issued']).map((s) => s.id)).toEqual(['r3'])
    expect(store.list('send', [])).toEqual([])
  })

  test('survives a restart, and a second connection cannot win a race the first already won', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'subdustd-store-')), 'db', 'swaps.sqlite')
    const a = SwapStore.open(path)
    a.create(send(1))
    const b = SwapStore.open(path)
    expect(a.transition('s1', 'init', 'funded')).toBe(true)
    expect(b.transition('s1', 'init', 'funded')).toBe(false)
    a.close()
    b.close()
    const reopened = SwapStore.open(path)
    expect(reopened.get('s1')?.state).toBe('funded')
    reopened.close()
  })

  test('refuses a database written by a newer build', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'subdustd-store-')), 'swaps.sqlite')
    SwapStore.open(path).close()
    const raw = new Database(path)
    raw.query('INSERT INTO schema_migrations (version, description, applied_at) VALUES (99, ?, 0)').run('future')
    raw.close()
    expect(() => SwapStore.open(path)).toThrow('newer than this build')
  })
})
