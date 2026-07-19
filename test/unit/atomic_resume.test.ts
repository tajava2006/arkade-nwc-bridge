import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteAtomicSwapRepository, SwapDirection } from '../../src/atomic'
import {
  RefundNotYetError,
  resumeAtomicSends,
  type AtomicSendDeps,
} from '../../src/atomic_send'
import type { Wallet } from '@arkade-os/sdk'

// resumeAtomicSends touches the network in three places: boltz's /send/status
// (global fetch — stubbed per test), the refund executor (injected), and the
// F4 spend confirmation (injected). Everything else is sqlite bookkeeping,
// asserted directly.

// Default F4 confirmation for the claimed path: pretend boltz's claim landed.
const spent = async (): Promise<boolean> => true
const notSpent = async (): Promise<boolean> => false

let db: Database
let repo: SqliteAtomicSwapRepository
const realFetch = globalThis.fetch

beforeEach(() => {
  db = new Database(':memory:')
  SqliteAtomicSwapRepository.migrate(db)
  repo = new SqliteAtomicSwapRepository(db)
})
afterEach(() => {
  globalThis.fetch = realFetch
  db.close()
})

const NOW = Math.floor(Date.now() / 1000)
const deps: AtomicSendDeps = {
  wallet: {} as Wallet, // never reached — refund is injected, status is fetch
  arkServerUrl: 'http://ark',
  db: undefined as never, // set in makeDeps
  boltzApiUrl: 'http://boltz',
}
const makeDeps = (): AtomicSendDeps => ({ ...deps, db })

function plantSend(id: string, state: 'funded' | 'ln_inflight' | 'refund_wait', refundLocktime: number): void {
  repo.create({
    id,
    direction: SwapDirection.Send,
    paymentHash: id.padEnd(64, '0'),
    state: 'init',
    amount: 21,
    refundLocktime,
    peerPubkey: 'cd'.repeat(32),
    exitDelay: 512,
  })
  repo.setFundingOutpoint(id, 'ab'.repeat(32) + ':0')
  repo.transition(id, 'funded')
  if (state === 'ln_inflight') repo.transition(id, 'ln_inflight')
  if (state === 'refund_wait') repo.transition(id, 'refund_wait')
}

function stubStatus(bodyBySwapId: Record<string, { state: string; preimage?: string } | 'down'>): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const swapId = new URL(String(url)).searchParams.get('swapId') ?? ''
    const body = bodyBySwapId[swapId]
    if (body === undefined || body === 'down') throw new Error('connection refused')
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
}

const noRefund = async (): Promise<never> => {
  throw new Error('refund must not be called in this scenario')
}

describe('resumeAtomicSends', () => {
  test('post-T refund_wait + boltz gone → refund fires (the T-refund executor)', async () => {
    plantSend('s-refund', 'refund_wait', NOW - 600)
    stubStatus({}) // boltz unreachable — the very scenario refund exists for
    const calls: string[] = []
    const r = await resumeAtomicSends(makeDeps(), async (_d, id) => {
      calls.push(id)
      // mirror what the real refund does to the row
      repo.transition(id, 'refunded')
      return { txid: 'r'.repeat(64), amount: 351 }
    })
    expect(calls).toEqual(['s-refund'])
    expect(r.refunded).toEqual(['s-refund'])
    expect(repo.get('s-refund')?.state).toBe('refunded')
  })

  test('post-T funded whose vtxo boltz already claimed (spend confirmed) → reconciled to claimed, not refunded', async () => {
    // crash between boltz's claim and our bookkeeping
    plantSend('s-crashed', 'funded', NOW - 600)
    stubStatus({ 's-crashed': { state: 'claimed', preimage: 'ef'.repeat(32) } })
    const r = await resumeAtomicSends(makeDeps(), noRefund, spent)
    expect(r.claimed).toEqual(['s-crashed'])
    expect(r.refunded).toEqual([])
    const row = repo.get('s-crashed')
    expect(row?.state).toBe('claimed')
    expect(row?.preimage).toBe('ef'.repeat(32))
  })

  test('F4: boltz says claimed but the shared vtxo is NOT spent → not claimed, kept recoverable', async () => {
    // a lying/buggy boltz (or a claim that ACKed but never registered): we must
    // not terminal-claim + release the vault while V is still in the shared vtxo
    plantSend('s-liar', 'ln_inflight', NOW + 3600) // pre-T so the poll path runs
    stubStatus({ 's-liar': { state: 'claimed', preimage: 'ab'.repeat(32) } })
    const r = await resumeAtomicSends(makeDeps(), noRefund, notSpent)
    expect(r.claimed).toEqual([]) // NOT reconciled to claimed on boltz's word alone
    const row = repo.get('s-liar')
    expect(row?.state).toBe('ln_inflight') // stays recoverable — refund executor handles T
    expect(row?.preimage).toBe('ab'.repeat(32)) // preimage still persisted (LN did pay)
  })

  test('F11: post-T claimed-but-unspent → falls through to auto-refund (not skipped)', async () => {
    // boltz's claim ACKed but never registered (poison / lie): boltz DB says
    // 'claimed' yet the shared vtxo is unspent. Post-T we must NOT stop at the
    // failed confirmation — the old code did `continue`, stranding V forever.
    plantSend('s-poison', 'ln_inflight', NOW - 600) // post-T
    stubStatus({ 's-poison': { state: 'claimed', preimage: 'ab'.repeat(32) } })
    const calls: string[] = []
    const r = await resumeAtomicSends(
      makeDeps(),
      async (_d, id) => {
        calls.push(id)
        repo.transition(id, 'refund_wait')
        repo.transition(id, 'refunded')
        return { txid: 'r'.repeat(64), amount: 351 }
      },
      notSpent, // F4 confirmation fails → markClaimed returns false → refund
    )
    expect(calls).toEqual(['s-poison']) // refund actually ran
    expect(r.refunded).toEqual(['s-poison'])
    expect(r.claimed).toEqual([])
    expect(repo.get('s-poison')?.state).toBe('refunded')
  })

  test('pre-T funded + boltz says failed → moves to refund_wait and waits for T', async () => {
    plantSend('s-failing', 'funded', NOW + 3600)
    stubStatus({ 's-failing': { state: 'failed' } })
    const r = await resumeAtomicSends(makeDeps(), noRefund)
    expect(r.refundWait).toEqual(['s-failing'])
    expect(repo.get('s-failing')?.state).toBe('refund_wait')
  })

  test('pre-T + boltz unreachable → waiting, nothing mutated', async () => {
    plantSend('s-quiet', 'ln_inflight', NOW + 3600)
    stubStatus({})
    const r = await resumeAtomicSends(makeDeps(), noRefund)
    expect(r.waiting).toBe(1)
    expect(repo.get('s-quiet')?.state).toBe('ln_inflight')
  })

  test('blocktime lag (RefundNotYetError) counts as waiting, not failure', async () => {
    plantSend('s-lag', 'refund_wait', NOW - 60)
    stubStatus({})
    const r = await resumeAtomicSends(makeDeps(), async () => {
      throw new RefundNotYetError('FORFEIT_CLOSURE_LOCKED (11)')
    })
    expect(r.waiting).toBe(1)
    expect(r.failed).toEqual([])
    expect(repo.get('s-lag')?.state).toBe('refund_wait') // untouched — next tick retries
  })

  test('receive rows and terminal rows are never touched', async () => {
    repo.create({
      id: 'r-1',
      direction: SwapDirection.Receive,
      paymentHash: 'f1'.repeat(32),
      state: 'invoice_issued',
      amount: 21,
      refundLocktime: NOW - 600,
    })
    plantSend('s-done', 'refund_wait', NOW - 600)
    repo.transition('s-done', 'refunded') // terminal
    stubStatus({})
    const r = await resumeAtomicSends(makeDeps(), noRefund)
    expect(r.refunded).toEqual([])
    expect(r.failed).toEqual([])
    expect(repo.get('r-1')?.state).toBe('invoice_issued')
  })

  test('a real refund failure is reported, isolated per swap', async () => {
    plantSend('s-bad', 'refund_wait', NOW - 600)
    plantSend('s-good', 'refund_wait', NOW - 600)
    stubStatus({})
    const r = await resumeAtomicSends(makeDeps(), async (_d, id) => {
      if (id === 's-bad') throw new Error('shared vtxo not found or already spent')
      repo.transition(id, 'refunded')
      return { txid: 'r'.repeat(64), amount: 351 }
    })
    expect(r.failed.map((f) => f.id)).toEqual(['s-bad'])
    expect(r.refunded).toEqual(['s-good'])
  })
})
