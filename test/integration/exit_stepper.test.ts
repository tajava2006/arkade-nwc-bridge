import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ChainTxType, SingleKey, type OnchainProvider } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { FIXTURE_CSV_BLOCKS, makeMockChain, makeSignedExitFixture } from '../helpers/exit'
import { storeVtxoWithProofs } from '../../src/exit/vault'
import { createOrRestartExitOp, setExitOpState } from '../../src/exit/ops'
import { buildExitStepper, type BroadcastStep, type SweepStep, type WaitStep } from '../../src/exit/stepper'

const walletKey = SingleKey.fromPrivateKey(new Uint8Array(32).fill(7))

describe('exit stepper', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('nothing broadcast yet: ark pending, commitment confirmed, CSV/sweep pending', async () => {
    const f = await makeSignedExitFixture(1, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const chain = makeMockChain() // nothing confirmed

    const stepper = await buildExitStepper(
      { db: temp.db, explorer: chain.explorer as unknown as OnchainProvider },
      f.txid,
      0,
      2,
    )!
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
  })

  test('vtxo confirmed, CSV still running: wait shows the countdown', async () => {
    const f = await makeSignedExitFixture(2, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const chain = makeMockChain()
    chain.confirm(f.txid)
    chain.advance(4) // 4 of 10 blocks elapsed

    const stepper = (await buildExitStepper(
      { db: temp.db, explorer: chain.explorer as unknown as OnchainProvider },
      f.txid,
      0,
      2,
    ))!
    const wait = stepper.steps.find((s) => s.kind === 'wait') as WaitStep
    expect(wait.status).toBe('running')
    expect(wait.need).toBe(Number(FIXTURE_CSV_BLOCKS))
    expect(wait.have).toBe(4)
    const arkStep = stepper.steps.find(
      (s): s is BroadcastStep => s.kind === 'broadcast' && s.txid === f.txid,
    )!
    expect(arkStep.status).toBe('confirmed')
  })

  test('CSV elapsed: wait sweepable, sweep available', async () => {
    const f = await makeSignedExitFixture(3, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const chain = makeMockChain()
    chain.confirm(f.txid)
    chain.advance(Number(FIXTURE_CSV_BLOCKS))

    const stepper = (await buildExitStepper(
      { db: temp.db, explorer: chain.explorer as unknown as OnchainProvider },
      f.txid,
      0,
      2,
    ))!
    expect((stepper.steps.find((s) => s.kind === 'wait') as WaitStep).status).toBe('sweepable')
    expect((stepper.steps.find((s) => s.kind === 'sweep') as SweepStep).status).toBe('sweepable')
  })

  test('swept op: sweep step done with the txid', async () => {
    const f = await makeSignedExitFixture(4, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0)
    setExitOpState(temp.db, f.txid, 0, 'swept', {
      sweepTxid: 'a'.repeat(64),
      destAddress: 'bc1pdest',
    })
    const chain = makeMockChain()
    chain.confirm(f.txid)
    chain.advance(Number(FIXTURE_CSV_BLOCKS))

    const stepper = (await buildExitStepper(
      { db: temp.db, explorer: chain.explorer as unknown as OnchainProvider },
      f.txid,
      0,
      2,
    ))!
    const sweep = stepper.steps.find((s) => s.kind === 'sweep') as SweepStep
    expect(sweep.status).toBe('done')
    expect(sweep.sweepTxid).toBe('a'.repeat(64))
    expect(sweep.destAddress).toBe('bc1pdest')
  })

  test('unknown vtxo → null', async () => {
    const chain = makeMockChain()
    const stepper = await buildExitStepper(
      { db: temp.db, explorer: chain.explorer as unknown as OnchainProvider },
      'f'.repeat(64),
      0,
      2,
    )
    expect(stepper).toBeNull()
  })
})
