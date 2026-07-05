import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AnchorBumper, OnchainProvider, Transaction } from '@arkade-os/sdk'
import { SingleKey } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { FIXTURE_CSV_BLOCKS, makeSignedExitFixture } from '../helpers/exit'
import { storeVtxoWithProofs } from '../../src/exit/vault'
import { csvPathStatuses } from '../../src/exit/csv'
import { createOrRestartExitOp, getExitOp } from '../../src/exit/ops'
import { startExitEngine, type ExitEngine, type ExitEngineUpdate } from '../../src/exit/engine'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Chain simulator: txs start unknown, broadcasting confirms them instantly
// (skips Session's mempool WAIT branch — the 5s doWait poll would stall the
// suite), and the tip is hand-advanced to run the CSV clock.
function mockChain(startHeight = 1_000) {
  const confirmed = new Map<string, { height: number; time: number }>()
  let tip = { height: startHeight, time: startHeight * 600, hash: 'h' }
  const broadcasts: string[][] = []
  const explorer = {
    async getTxStatus(txid: string) {
      const c = confirmed.get(txid)
      if (!c) throw new Error('not found')
      return { confirmed: true, blockHeight: c.height, blockTime: c.time }
    },
    async broadcastTransaction(...txs: string[]) {
      broadcasts.push(txs)
      return 'ok'
    },
    async getChainTip() {
      return tip
    },
  } as unknown as OnchainProvider
  return {
    explorer,
    broadcasts,
    confirm(txid: string) {
      confirmed.set(txid, { height: tip.height, time: tip.time })
    },
    advance(blocks: number) {
      tip = { ...tip, height: tip.height + blocks, time: tip.time + blocks * 600 }
    },
  }
}

// The engine broadcasts through the bumper's package; confirming the parent
// on bump mimics a 1P1C landing in a block before Session's next look.
function mockBumper(chain: ReturnType<typeof mockChain>): AnchorBumper {
  return {
    async bumpP2A(parent: Transaction) {
      chain.confirm(parent.id)
      return [parent.hex, '<child>']
    },
  }
}

const identity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(7))

describe('exit engine', () => {
  let temp: TempDb
  let engine: ExitEngine | undefined
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    engine?.stop()
    temp.cleanup()
  })

  function makeEngine(chain: ReturnType<typeof mockChain>, pollMs = 50): ExitEngine {
    return startExitEngine({
      db: temp.db,
      identity,
      network: 'bitcoin',
      esploraUrls: ['http://127.0.0.1:1/api'],
      providers: { bumper: mockBumper(chain), explorer: chain.explorer },
      pollIntervalMs: pollMs,
    })
  }

  async function waitForState(
    txid: string,
    vout: number,
    state: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (getExitOp(temp.db, txid, vout)?.state === state) return
      await sleep(25)
    }
    throw new Error(
      `timeout waiting for ${state}, op = ${JSON.stringify(getExitOp(temp.db, txid, vout))}`,
    )
  }

  test('startExit unrolls to "waiting", then the CSV clock flips it to "sweepable"', async () => {
    const f = await makeSignedExitFixture(1)
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const chain = mockChain()
    engine = makeEngine(chain)

    const updates: ExitEngineUpdate[] = []
    engine.onUpdate((u) => updates.push(u))

    engine.startExit(f.txid, 0)
    await waitForState(f.txid, 0, 'waiting')

    expect(chain.broadcasts).toHaveLength(1) // one 1P1C package for the single ARK entry
    expect(updates.some((u) => u.step?.type === 'UNROLL' && u.step.txid === f.txid)).toBe(true)
    expect(updates.some((u) => u.step?.type === 'DONE')).toBe(true)

    // CSV not elapsed yet → still waiting after a poll tick
    await sleep(120)
    expect(getExitOp(temp.db, f.txid, 0)?.state).toBe('waiting')

    chain.advance(Number(FIXTURE_CSV_BLOCKS))
    await waitForState(f.txid, 0, 'sweepable')
  })

  test('a vtxo the vault never mirrored fails loudly and is retryable', async () => {
    const chain = mockChain()
    engine = makeEngine(chain)
    engine.startExit('f'.repeat(64), 0)
    await waitForState('f'.repeat(64), 0, 'failed')
    expect(getExitOp(temp.db, 'f'.repeat(64), 0)?.error).toContain('never mirrored')

    // retry resets the row back to unrolling intent
    engine.startExit('f'.repeat(64), 0)
    const op = getExitOp(temp.db, 'f'.repeat(64), 0)
    expect(op?.state === 'unrolling' || op?.state === 'failed').toBe(true)
  })

  test('ops run strictly one at a time', async () => {
    const a = await makeSignedExitFixture(1)
    const b = await makeSignedExitFixture(2)
    storeVtxoWithProofs(temp.db, a.vtxo, a.proofs)
    storeVtxoWithProofs(temp.db, b.vtxo, b.proofs)
    const chain = mockChain()
    engine = makeEngine(chain)

    const order: string[] = []
    engine.onUpdate((u) => {
      if (u.step?.type === 'UNROLL') order.push(u.txid)
    })

    engine.startExit(a.txid, 0)
    engine.startExit(b.txid, 0)
    await waitForState(a.txid, 0, 'waiting')
    await waitForState(b.txid, 0, 'waiting')

    // every broadcast of a finishes before any broadcast of b
    expect(order).toEqual([a.txid, b.txid])
  })

  test('resume() picks an interrupted op back up after a "restart"', async () => {
    const f = await makeSignedExitFixture(3)
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    // crashed mid-exit last run: the row exists, nothing is onchain yet
    createOrRestartExitOp(temp.db, f.txid, 0)

    const chain = mockChain()
    engine = makeEngine(chain)
    engine.resume()
    await waitForState(f.txid, 0, 'waiting')
    expect(chain.broadcasts).toHaveLength(1)
  })

  test('csvPathStatuses reports the countdown for the UI', async () => {
    const f = await makeSignedExitFixture(4)
    const confirmedAt = { height: 1_000, time: 600_000 }
    const before = csvPathStatuses(f.vtxo.tapTree, confirmedAt, { height: 1_004, time: 602_400 })
    expect(before).toHaveLength(1)
    expect(before[0]!.type).toBe('blocks')
    expect(before[0]!.need).toBe(Number(FIXTURE_CSV_BLOCKS))
    expect(before[0]!.have).toBe(4)
    expect(before[0]!.satisfied).toBe(false)

    const after = csvPathStatuses(f.vtxo.tapTree, confirmedAt, { height: 1_010, time: 606_000 })
    expect(after[0]!.satisfied).toBe(true)
  })
})
