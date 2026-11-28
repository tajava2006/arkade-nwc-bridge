import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { Wallet } from '@arkade-os/sdk'
import { SqliteAtomicSwapRepository, SwapDirection } from '../../src/atomic'
import { resumeAtomicSends, type AtomicSendDeps } from '../../src/atomic/send'
import { openDatabase } from '../../src/db'
import { createOrRestartExitOp, setExitOpState, SWAP_EXIT_RETRY_SECS } from '../../src/exit/ops'

// A send the exit engine took on chain (F32_VHTLC_PLAN S4) is reconciled from
// its exit op, not from an offchain refund: swept → refunded, a failed exit is
// restarted (with a backoff), and subdustd turning up with a preimage that
// opens the hash books the send as paid. The full bridge schema, since the
// exit tables live there.

const TXID = 'ab'.repeat(32)
const NOW = Math.floor(Date.now() / 1000)
const sha256 = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const realFetch = globalThis.fetch

let db: Database
let repo: SqliteAtomicSwapRepository
let exits: [string, number][]
const deps = (): AtomicSendDeps => ({
  wallet: {} as Wallet,
  arkServerUrl: 'http://ark',
  db,
  subdustdUrl: 'http://subdustd',
  startExit: (t, v) => exits.push([t, v]),
})
const mustNotRefund = async (): Promise<never> => {
  throw new Error('the offchain refund must not run once the exit engine owns the send')
}

function plant(id: string, paymentHash: string): void {
  repo.create({
    id,
    direction: SwapDirection.Send,
    paymentHash,
    state: 'init',
    amount: 5_000,
    refundLocktime: NOW - 600,
    peerPubkey: 'cd'.repeat(32),
    exitDelay: 512,
  })
  repo.setFundingOutpoint(id, `${TXID}:0`)
  repo.transition(id, 'funded')
  repo.transition(id, 'ln_inflight')
}
const subdustdSays = (body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
}

beforeEach(() => {
  db = openDatabase(join(mkdtempSync(join(tmpdir(), 'exit-resume-')), 'bridge.sqlite'))
  repo = new SqliteAtomicSwapRepository(db)
  exits = []
})
afterEach(() => {
  globalThis.fetch = realFetch
  db.close()
})

describe('resumeAtomicSends with the swap on chain', () => {
  test('swept → refunded (through refund_wait), no offchain refund attempted', async () => {
    plant('s1', 'aa'.repeat(32))
    createOrRestartExitOp(db, TXID, 0)
    setExitOpState(db, TXID, 0, 'swept', { sweepTxid: 'ee'.repeat(32) })
    subdustdSays({ state: 'ln_inflight' })
    const r = await resumeAtomicSends(deps(), mustNotRefund)
    expect(r.refunded).toEqual(['s1'])
    expect(repo.get('s1')?.state).toBe('refunded')
  })

  test('a failed exit is restarted — not before the backoff', async () => {
    plant('s2', 'bb'.repeat(32))
    createOrRestartExitOp(db, TXID, 0)
    setExitOpState(db, TXID, 0, 'failed', { error: 'TRUC-violation' })
    subdustdSays({ state: 'ln_inflight' })
    await resumeAtomicSends(deps(), mustNotRefund)
    expect(exits).toEqual([]) // just failed: wait
    db.query('UPDATE exit_ops SET updated_at = ?').run(NOW - SWAP_EXIT_RETRY_SECS - 1)
    const r = await resumeAtomicSends(deps(), mustNotRefund)
    expect(exits).toEqual([[TXID, 0]])
    expect(r.waiting).toBe(1)
    expect(repo.get('s2')?.state).toBe('ln_inflight')
  })

  test('subdustd back with the preimage → claimed (the LN payment is proven), preimage on the row', async () => {
    const preimage = randomBytes(32).toString('hex')
    plant('s3', sha256(preimage))
    createOrRestartExitOp(db, TXID, 0)
    subdustdSays({ state: 'claimed', preimage })
    const r = await resumeAtomicSends(deps(), mustNotRefund)
    expect(r.claimed).toEqual(['s3'])
    expect(repo.get('s3')).toMatchObject({ state: 'claimed', preimage })
  })

  test('a "claimed" whose preimage does not open the hash proves nothing → still exiting', async () => {
    plant('s4', 'cc'.repeat(32))
    createOrRestartExitOp(db, TXID, 0)
    subdustdSays({ state: 'claimed', preimage: 'dd'.repeat(32) })
    const r = await resumeAtomicSends(deps(), mustNotRefund)
    expect(r.claimed).toEqual([])
    expect(r.waiting).toBe(1)
    expect(repo.get('s4')?.state).toBe('ln_inflight')
  })
})
