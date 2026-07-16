import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ChainTxType, SingleKey, type ChainTx, type OnchainProvider } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { FIXTURE_CSV_BLOCKS, makeMockChain, makeSignedExitFixture } from '../helpers/exit'
import { storeVtxoWithProofs } from '../../src/exit/vault'
import { createOrRestartExitOp, setExitOpState } from '../../src/exit/ops'
import { buildExitStepper, probeExitStep } from '../../src/exit/stepper'

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

  test('no op: commitment level on top, rest pending, probe covers the broadcast set', async () => {
    const f = await makeSignedExitFixture(1, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)

    const stepper = buildExitStepper({ db: temp.db }, f.txid, 0, 2)
    expect(stepper).not.toBeNull()
    // DAG layers: commitments first, the vtxo tx in the last level
    expect(stepper!.levels[0]![0]!.txType).toBe(ChainTxType.COMMITMENT)
    expect(stepper!.levels[0]![0]!.status).toBe('confirmed')
    const flat = stepper!.levels.flat()
    const arkStep = flat.find((s) => s.txid === f.txid)!
    expect(arkStep.status).toBe('pending')
    expect(arkStep.vsize).toBeGreaterThan(100) // measured, matches the estimate
    expect(stepper!.wait.status).toBe('pending')
    expect(stepper!.sweep.status).toBe('pending')
    // unroll order, commitment excluded — the client stops at the first
    // non-confirmed answer, so for an untouched vtxo one probe settles it
    expect(stepper!.probe).toEqual([f.txid])
    expect(stepper!.edges).toContainEqual({ parent: f.parentTxid, child: f.txid })
  })

  test('two-branch chain (commitment mid-array): commitments top, probe follows the session scan', () => {
    // the shape arkd's BFS emits when a short branch settles mid-walk — the
    // display must recover the DAG, while the probe order stays glued to how
    // Session actually scans the stored array (back-to-front)
    const chain: ChainTx[] = [
      { txid: 'v1', type: ChainTxType.ARK, expiresAt: '', spends: ['k1', 'k2'] },
      { txid: 'k1', type: ChainTxType.CHECKPOINT, expiresAt: '', spends: ['t1:0'] },
      { txid: 'k2', type: ChainTxType.CHECKPOINT, expiresAt: '', spends: ['b1:1'] },
      { txid: 't1', type: ChainTxType.TREE, expiresAt: '', spends: ['c1'] },
      { txid: 'c1', type: ChainTxType.COMMITMENT, expiresAt: '', spends: [] },
      { txid: 'b1', type: ChainTxType.ARK, expiresAt: '', spends: ['k3'] },
      { txid: 'k3', type: ChainTxType.CHECKPOINT, expiresAt: '', spends: ['t2:0'] },
      { txid: 't2', type: ChainTxType.TREE, expiresAt: '', spends: ['c2'] },
      { txid: 'c2', type: ChainTxType.COMMITMENT, expiresAt: '', spends: [] },
    ]
    storeVtxoWithProofs(
      temp.db,
      {
        txid: 'v1',
        vout: 0,
        source: 'wallet',
        valueSat: 1000,
        script: '5120' + 'ab'.repeat(32),
        tapTree: 'c0de',
        status: 'preconfirmed',
        expiresAt: null,
        chain,
      },
      [],
    )

    const stepper = buildExitStepper({ db: temp.db }, 'v1', 0, 2)!
    const ids = stepper.levels.map((l) => l.map((s) => s.txid))
    expect(ids).toEqual([['c1', 'c2'], ['t1', 't2'], ['k1', 'k3'], ['b1'], ['k2'], ['v1']])
    // reverse of the stored array minus commitments = Session's broadcast order
    expect(stepper.probe).toEqual(['t2', 'k3', 'b1', 't1', 'k2', 'k1', 'v1'])
  })

  test('op waiting: broadcasts confirmed from the op alone, CSV numbers deferred to one probe', async () => {
    const f = await makeSignedExitFixture(2, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0)
    setExitOpState(temp.db, f.txid, 0, 'waiting')

    const stepper = buildExitStepper({ db: temp.db }, f.txid, 0, 2)!
    const arkStep = stepper.levels.flat().find((s) => s.txid === f.txid)!
    expect(arkStep.status).toBe('confirmed')
    expect(stepper.wait.status).toBe('running')
    expect(stepper.wait.need).toBe(Number(FIXTURE_CSV_BLOCKS))
    expect(stepper.wait.have).toBeNull() // countdown comes from the vtxo-tx probe
    expect(stepper.probe).toEqual([f.txid])
  })

  test('op sweepable: everything final, nothing to probe', async () => {
    const f = await makeSignedExitFixture(3, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0)
    setExitOpState(temp.db, f.txid, 0, 'sweepable')

    const stepper = buildExitStepper({ db: temp.db }, f.txid, 0, 2)!
    expect(stepper.wait.status).toBe('sweepable')
    expect(stepper.sweep.status).toBe('sweepable')
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
    expect(stepper.sweep.status).toBe('done')
    expect(stepper.sweep.sweepTxid).toBe('a'.repeat(64))
    expect(stepper.sweep.destAddress).toBe('bc1pdest')
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
