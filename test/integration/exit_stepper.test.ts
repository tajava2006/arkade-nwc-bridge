import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ChainTxType, SingleKey, type OnchainProvider } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { FIXTURE_CSV_BLOCKS, makeMockChain, makeSignedExitFixture } from '../helpers/exit'
import { storeVtxoWithProofs } from '../../src/exit/vault'
import { createOrRestartExitOp, setExitOpState } from '../../src/exit/ops'
import {
  buildExitStepper,
  probeExitStep,
  type BroadcastStep,
  type SweepStep,
  type WaitStep,
} from '../../src/exit/stepper'

const walletKey = SingleKey.fromPrivateKey(new Uint8Array(32).fill(7))

// buildExitStepper is DB-only by design: onchain statuses come from the
// client's probe loop, so the build must render sensibly with zero network.
describe('exit stepper (DB-only build)', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('no op: commitment confirmed, rest pending, probe covers the broadcast set', async () => {
    const f = await makeSignedExitFixture(1, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)

    const stepper = buildExitStepper({ db: temp.db }, f.txid, 0, 2)
    expect(stepper).not.toBeNull()
    const steps = stepper!.steps
    // display order root→leaf: commitment first, ark tx last (before wait/sweep)
    const broadcasts = steps.filter((s): s is BroadcastStep => s.kind === 'broadcast')
    expect(broadcasts[0]!.txType).toBe(ChainTxType.COMMITMENT)
    expect(broadcasts[0]!.status).toBe('confirmed')
    const arkStep = broadcasts.find((s) => s.txid === f.txid)!
    expect(arkStep.status).toBe('pending')
    expect(arkStep.vsize).toBeGreaterThan(100) // measured, matches the estimate
    expect((steps.find((s) => s.kind === 'wait') as WaitStep).status).toBe('pending')
    expect((steps.find((s) => s.kind === 'sweep') as SweepStep).status).toBe('pending')
    // broadcast order, commitment excluded — the client stops at the first
    // non-confirmed answer, so for an untouched vtxo one probe settles it
    expect(stepper!.probe).toEqual([f.txid])
  })

  test('op waiting: broadcasts confirmed from the op alone, CSV numbers deferred to one probe', async () => {
    const f = await makeSignedExitFixture(2, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0)
    setExitOpState(temp.db, f.txid, 0, 'waiting')

    const stepper = buildExitStepper({ db: temp.db }, f.txid, 0, 2)!
    const arkStep = stepper.steps.find(
      (s): s is BroadcastStep => s.kind === 'broadcast' && s.txid === f.txid,
    )!
    expect(arkStep.status).toBe('confirmed')
    const wait = stepper.steps.find((s) => s.kind === 'wait') as WaitStep
    expect(wait.status).toBe('running')
    expect(wait.need).toBe(Number(FIXTURE_CSV_BLOCKS))
    expect(wait.have).toBeNull() // countdown comes from the vtxo-tx probe
    expect(stepper.probe).toEqual([f.txid])
  })

  test('op sweepable: everything final, nothing to probe', async () => {
    const f = await makeSignedExitFixture(3, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0)
    setExitOpState(temp.db, f.txid, 0, 'sweepable')

    const stepper = buildExitStepper({ db: temp.db }, f.txid, 0, 2)!
    expect((stepper.steps.find((s) => s.kind === 'wait') as WaitStep).status).toBe('sweepable')
    expect((stepper.steps.find((s) => s.kind === 'sweep') as SweepStep).status).toBe('sweepable')
    expect(stepper.probe).toEqual([])
  })

  test('swept op: sweep step done with the txid, nothing to probe', async () => {
    const f = await makeSignedExitFixture(4, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0)
    setExitOpState(temp.db, f.txid, 0, 'swept', {
      sweepTxid: 'a'.repeat(64),
      destAddress: 'bc1pdest',
    })

    const stepper = buildExitStepper({ db: temp.db }, f.txid, 0, 2)!
    const sweep = stepper.steps.find((s) => s.kind === 'sweep') as SweepStep
    expect(sweep.status).toBe('done')
    expect(sweep.sweepTxid).toBe('a'.repeat(64))
    expect(sweep.destAddress).toBe('bc1pdest')
    expect(stepper.probe).toEqual([])
  })

  test('unknown vtxo → null', () => {
    expect(buildExitStepper({ db: temp.db }, 'f'.repeat(64), 0, 2)).toBeNull()
  })
})

describe('probeExitStep', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('unbroadcast tx: pending, vsize measured, no wait fragment', async () => {
    const f = await makeSignedExitFixture(5, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const chain = makeMockChain() // knows no tx

    const p = await probeExitStep(
      { db: temp.db, explorer: chain.explorer as unknown as OnchainProvider },
      f.txid,
      0,
      f.txid,
    )
    expect(p).not.toBeNull()
    expect(p!.status).toBe('pending')
    expect(p!.step.vsize).toBeGreaterThan(100)
    expect(p!.wait).toBeUndefined()
  })

  test('mempool tx: reported as mempool (stops the client scan)', async () => {
    const f = await makeSignedExitFixture(6, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const explorer = {
      getTxStatus: async () => ({ confirmed: false }),
      getChainTip: async () => ({ height: 1, time: 600, hash: 'h' }),
    }

    const p = await probeExitStep(
      { db: temp.db, explorer: explorer as unknown as OnchainProvider },
      f.txid,
      0,
      f.txid,
    )
    expect(p!.status).toBe('mempool')
    expect(p!.wait).toBeUndefined()
  })

  test('confirmed vtxo tx: CSV countdown + sweep fragments ride along', async () => {
    const f = await makeSignedExitFixture(7, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const chain = makeMockChain()
    chain.confirm(f.txid)
    chain.advance(4) // 4 of 10 blocks elapsed

    const p = await probeExitStep(
      { db: temp.db, explorer: chain.explorer as unknown as OnchainProvider },
      f.txid,
      0,
      f.txid,
    )
    expect(p!.status).toBe('confirmed')
    expect(p!.wait!.status).toBe('running')
    expect(p!.wait!.need).toBe(Number(FIXTURE_CSV_BLOCKS))
    expect(p!.wait!.have).toBe(4)
    expect(p!.sweep!.status).toBe('pending')
  })

  test('CSV elapsed: wait and sweep flip to sweepable', async () => {
    const f = await makeSignedExitFixture(8, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const chain = makeMockChain()
    chain.confirm(f.txid)
    chain.advance(Number(FIXTURE_CSV_BLOCKS))

    const p = await probeExitStep(
      { db: temp.db, explorer: chain.explorer as unknown as OnchainProvider },
      f.txid,
      0,
      f.txid,
    )
    expect(p!.wait!.status).toBe('sweepable')
    expect(p!.sweep!.status).toBe('sweepable')
  })

  test('rejects txids outside the chain and commitment entries', async () => {
    const f = await makeSignedExitFixture(9, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const chain = makeMockChain()
    const deps = { db: temp.db, explorer: chain.explorer as unknown as OnchainProvider }

    expect(await probeExitStep(deps, f.txid, 0, 'e'.repeat(64))).toBeNull()
    // commitment is chain metadata, not a broadcastable step
    expect(await probeExitStep(deps, f.txid, 0, f.parentTxid)).toBeNull()
    // unknown vtxo
    expect(await probeExitStep(deps, 'f'.repeat(64), 0, f.txid)).toBeNull()
  })

  test('hung explorer degrades to pending within the timeout', async () => {
    const f = await makeSignedExitFixture(10, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const explorer = {
      getTxStatus: () => new Promise(() => {}),
      getChainTip: () => new Promise(() => {}),
    }

    const p = await probeExitStep(
      { db: temp.db, explorer: explorer as unknown as OnchainProvider, timeoutMs: 50 },
      f.txid,
      0,
      f.txid,
    )
    expect(p!.status).toBe('pending')
  })
})
