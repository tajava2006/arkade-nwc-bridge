import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteAtomicSwapRepository, SwapDirection } from '../../src/atomic'
import {
  inflightSends,
  RefundNotYetError,
  resumeAtomicSends,
  type AtomicSendDeps,
} from '../../src/atomic/send'
import type { Wallet } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'

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

// Default cancel stub: boltz declines (older build / still paying / gone). This
// is the pre-cancel behaviour, so every legacy expectation below must hold
// under it — the cancel leaf may only ever ADD a recovery, never remove one.
const noCancel = async (): Promise<never> => {
  throw new Error('boltz refused the cooperative cancel (unavailable)')
}
/** Cancel stub that mirrors what the real one does to the row. */
const okCancel = (seen: string[]) => async (_d: unknown, id: string) => {
  seen.push(id)
  repo.transition(id, 'cancelled')
  return { txid: 'c'.repeat(64), amount: 351 }
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

  test('pre-T funded + boltz says failed, cancel unavailable → refund_wait, waits for T', async () => {
    plantSend('s-failing', 'funded', NOW + 3600)
    stubStatus({ 's-failing': { state: 'failed' } })
    const r = await resumeAtomicSends(makeDeps(), noRefund, spent, noCancel)
    expect(r.refundWait).toEqual(['s-failing'])
    expect(r.cancelled).toEqual([])
    expect(r.waiting).toBe(1) // a declined cancel is waiting, never a failure
    expect(r.failed).toEqual([])
    expect(repo.get('s-failing')?.state).toBe('refund_wait')
  })

  test('pre-T + boltz unreachable → waiting, nothing mutated', async () => {
    plantSend('s-quiet', 'ln_inflight', NOW + 3600)
    stubStatus({})
    const r = await resumeAtomicSends(makeDeps(), noRefund, spent, noCancel)
    expect(r.waiting).toBe(1)
    expect(repo.get('s-quiet')?.state).toBe('ln_inflight')
  })

  // ── cooperative cancel: the funding comes back on failure, not at T ────────

  test('pre-T funded + boltz says failed → unwound in the SAME pass, not next tick', async () => {
    plantSend('s-unwind', 'funded', NOW + 3600)
    stubStatus({ 's-unwind': { state: 'failed' } })
    const seen: string[] = []
    const r = await resumeAtomicSends(makeDeps(), noRefund, spent, okCancel(seen))
    expect(seen).toEqual(['s-unwind'])
    expect(r.cancelled).toEqual(['s-unwind'])
    expect(repo.get('s-unwind')?.state).toBe('cancelled')
  })

  test('retro: a row stranded in refund_wait by a pre-cancel build is reclaimed on the next tick', async () => {
    // Nothing about the row needs migrating — classifyResume simply has an
    // action for it now. This is the whole answer to "do my stuck swaps clear
    // themselves once this ships".
    plantSend('s-stranded', 'refund_wait', NOW + 3600) // pre-T: was a dead wait before
    stubStatus({})
    const seen: string[] = []
    const r = await resumeAtomicSends(makeDeps(), noRefund, spent, okCancel(seen))
    expect(seen).toEqual(['s-stranded'])
    expect(r.cancelled).toEqual(['s-stranded'])
    expect(repo.get('s-stranded')?.state).toBe('cancelled')
  })

  test('a declined cancel leaves the T-refund intact — same row refunds once T passes', async () => {
    plantSend('s-fallback', 'refund_wait', NOW + 3600)
    stubStatus({})
    const before = await resumeAtomicSends(makeDeps(), noRefund, spent, noCancel)
    expect(before.cancelled).toEqual([])
    expect(before.waiting).toBe(1)
    expect(repo.get('s-fallback')?.state).toBe('refund_wait') // still recoverable

    // …now T elapses (rewrite the row's locktime the way the clock would).
    db.query('UPDATE atomic_swaps SET refund_locktime = ? WHERE id = ?').run(NOW - 600, 's-fallback')
    const after = await resumeAtomicSends(
      makeDeps(),
      async (_d, id) => {
        repo.transition(id, 'refunded')
        return { txid: 'r'.repeat(64), amount: 351 }
      },
      spent,
      noCancel,
    )
    expect(after.refunded).toEqual(['s-fallback'])
  })

  test('operator DM: a successful cancel is announced once as a refund', async () => {
    plantSend('s-dm-cancel', 'refund_wait', NOW + 3600)
    stubStatus({})
    const calls: Array<{ kind: string; text: string }> = []
    const notify = ((kind: string, build: () => string) => calls.push({ kind, text: build() })) as never
    // The real cancelAtomicSend owns the DM; the stub stands in for it here.
    await resumeAtomicSends({ ...makeDeps(), notify }, noRefund, spent, async (d, id) => {
      repo.transition(id, 'cancelled')
      ;(d as { notify?: (k: string, b: () => string) => void }).notify?.(
        'refund',
        () => 'send: sub-dust cancelled early — 351 sats returned without waiting for T',
      )
      return { txid: 'c'.repeat(64), amount: 351 }
    })
    expect(calls.length).toBe(1)
    expect(calls[0]!.kind).toBe('refund')
    expect(calls[0]!.text).toContain('without waiting for T')
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

  test('operator DM: claimed reconcile says "after restart", once — terminal row goes silent', async () => {
    plantSend('s-dm-claim', 'ln_inflight', NOW + 3600)
    stubStatus({ 's-dm-claim': { state: 'claimed', preimage: 'ee'.repeat(32) } })
    const calls: Array<{ kind: string; text: string }> = []
    const deps = {
      ...makeDeps(),
      notify: ((kind: string, build: () => string) =>
        calls.push({ kind, text: build() })) as never,
    }
    await resumeAtomicSends(deps, noRefund, spent)
    expect(calls.length).toBe(1)
    expect(calls[0]!.kind).toBe('send-subdust')
    expect(calls[0]!.text).toContain('after restart')
    expect(calls[0]!.text).toContain('21 sats')

    // Terminal now — listResumable excludes it, so the next pass can't re-DM.
    await resumeAtomicSends(deps, noRefund, spent)
    expect(calls.length).toBe(1)
  })

  // F19: rows a live atomicSubdustSend is driving are off-limits to the
  // reconciler. The boltz-ws poke runs a pass right at swap creation, so
  // without the skip the F15 pre-pass steals the funding bookkeeping mid-send
  // (illegal funded→funded on the live path — mainnet 2026-07-29) and
  // markClaimed races the live 'claimed' transition the same way.

  test('F19: in-flight init row is untouched — no recovery attempt, no status poll', async () => {
    repo.create({
      id: 's-live',
      direction: SwapDirection.Send,
      paymentHash: 'aa'.repeat(32),
      state: 'init', // exactly the fundShared→setFundingOutpoint window
      amount: 21,
      refundLocktime: NOW + 3600,
      peerPubkey: 'cd'.repeat(32),
      exitDelay: 512,
    })
    inflightSends.add('s-live')
    try {
      let fetches = 0
      globalThis.fetch = (async () => {
        fetches++
        throw new Error('the reconciler must not touch a live send at all')
      }) as unknown as typeof fetch
      const r = await resumeAtomicSends(makeDeps(), noRefund)
      expect(repo.get('s-live')?.state).toBe('init') // the live send will advance it
      expect(r.failed).toEqual([])
      expect(r.waiting).toBe(1)
      expect(fetches).toBe(0)
    } finally {
      inflightSends.delete('s-live')
    }
  })

  test('F19 control: the same row NOT in-flight still gets the F15 recovery attempt', async () => {
    // Pins that the skip above is what protects the live row — a genuine
    // crash orphan (send died, finally released the id) must keep being
    // recovered. The stubbed ark is down, so the attempt surfaces as failed.
    repo.create({
      id: 's-orphan',
      direction: SwapDirection.Send,
      paymentHash: 'bb'.repeat(32),
      state: 'init',
      amount: 21,
      refundLocktime: NOW + 3600,
      peerPubkey: 'cd'.repeat(32),
      exitDelay: 512,
    })
    stubStatus({}) // every endpoint down
    const r = await resumeAtomicSends(makeDeps(), noRefund)
    expect(r.failed.map((f) => f.id)).toEqual(['s-orphan'])
  })

  test('F19: in-flight ln_inflight row is not markClaimed underneath the live send', async () => {
    plantSend('s-live-claim', 'ln_inflight', NOW + 3600)
    inflightSends.add('s-live-claim')
    try {
      stubStatus({ 's-live-claim': { state: 'claimed', preimage: 'ab'.repeat(32) } })
      const r = await resumeAtomicSends(makeDeps(), noRefund, spent)
      expect(r.claimed).toEqual([]) // the live flow does its own 'claimed' transition
      expect(r.waiting).toBe(1)
      expect(repo.get('s-live-claim')?.state).toBe('ln_inflight')
    } finally {
      inflightSends.delete('s-live-claim')
    }
  })

  test('operator DM: failed→refund_wait notifies on the transition edge only', async () => {
    plantSend('s-dm-rw', 'funded', NOW + 3600)
    stubStatus({ 's-dm-rw': { state: 'failed' } })
    const calls: Array<{ kind: string; text: string }> = []
    const deps = {
      ...makeDeps(),
      notify: ((kind: string, build: () => string) =>
        calls.push({ kind, text: build() })) as never,
    }
    await resumeAtomicSends(deps, noRefund, spent, noCancel)
    expect(calls.length).toBe(1)
    expect(calls[0]!.kind).toBe('send-fail')
    expect(calls[0]!.text).toContain('reclaiming the funding')

    // Still refund_wait pre-T on the next poll — the state gate keeps quiet.
    await resumeAtomicSends(deps, noRefund, spent, noCancel)
    expect(calls.length).toBe(1)
  })

  // A send whose funding spend was REJECTED (concurrent send took the same
  // vtxo — no input lock yet) leaves an 'init' row with no outpoint. Nothing
  // was created, so there is no shared vtxo, no proof and nothing to refund;
  // classifyResume maps 'init' to 'poll' regardless of T, so it used to sit in
  // the dashboard's in-flight list forever behind a meaningless "refund T … ago".
  describe('unfunded init rows', () => {
    // classifyUnfundedInit rebuilds the 4-leaf taproot script, so unlike the
    // other suites these need REAL curve points, not filler bytes.
    const key = (seed: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(seed))
    const withIdentity = (): AtomicSendDeps => ({
      ...makeDeps(),
      wallet: { identity: { xOnlyPublicKey: async () => key(9) } } as never,
    })

    let hashSeq = 0
    const plantInit = (id: string, createdAt: number): void => {
      repo.create({
        id,
        direction: SwapDirection.Send,
        // must be real hex: classifyUnfundedInit decodes it to rebuild the script
        paymentHash: (hashSeq++).toString(16).padStart(2, '0').repeat(32),
        state: 'init',
        amount: 21,
        refundLocktime: NOW + 3600,
        peerPubkey: hex.encode(key(11)),
        exitDelay: 512,
      })
      db.query('UPDATE atomic_swaps SET created_at = ? WHERE id = ?').run(createdAt, id)
    }

    /** Indexer that reports nothing at any script — i.e. funding never landed. */
    const stubEmptyIndexer = (): void => {
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url)
        if (u.includes('/v1/info')) {
          return new Response(
            JSON.stringify({
              signerPubkey: hex.encode(key(13)),
              dust: '330',
              vtxoMinAmount: '1',
              unilateralExitDelay: '512',
              checkpointTapscript: '',
              network: 'regtest',
            }),
            { status: 200 },
          )
        }
        if (u.includes('/vtxos')) return new Response(JSON.stringify({ vtxos: [] }), { status: 200 })
        throw new Error('connection refused')
      }) as unknown as typeof fetch
    }

    test('past the grace with no coin ever at its script → failed, out of in-flight', async () => {
      plantInit('s-never-funded', NOW - 4 * 3600)
      stubEmptyIndexer()
      const r = await resumeAtomicSends(withIdentity(), noRefund, spent, noCancel)
      expect(r.unfunded).toEqual(['s-never-funded'])
      expect(repo.get('s-never-funded')?.state).toBe('failed')
      // terminal ⇒ listResumable drops it, so the next pass is silent
      expect((await resumeAtomicSends(makeDeps(), noRefund, spent, noCancel)).unfunded).toEqual([])
    })

    test('inside the grace it is left alone — the indexer may just be lagging its own write', async () => {
      plantInit('s-fresh', NOW - 30)
      stubEmptyIndexer()
      const r = await resumeAtomicSends(withIdentity(), noRefund, spent, noCancel)
      expect(r.unfunded).toEqual([])
      expect(repo.get('s-fresh')?.state).toBe('init')
    })

    test('a live send is never touched, however old the row', async () => {
      plantInit('s-live-init', NOW - 4 * 3600)
      inflightSends.add('s-live-init')
      try {
        stubEmptyIndexer()
        const r = await resumeAtomicSends(withIdentity(), noRefund, spent, noCancel)
        expect(r.unfunded).toEqual([])
        expect(repo.get('s-live-init')?.state).toBe('init')
      } finally {
        inflightSends.delete('s-live-init')
      }
    })

    test('an indexer that cannot answer never terminalizes a row', async () => {
      plantInit('s-blind', NOW - 4 * 3600)
      stubStatus({}) // every endpoint down
      const r = await resumeAtomicSends(withIdentity(), noRefund, spent, noCancel)
      expect(r.unfunded).toEqual([])
      expect(repo.get('s-blind')?.state).toBe('init')
    })
  })
})
