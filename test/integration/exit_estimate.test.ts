import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ChainTxType, SingleKey } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { makeSignedExitFixture } from '../helpers/exit'
import { storeVtxoWithProofs } from '../../src/exit/vault'
import { estimateExit } from '../../src/exit/estimate'

const walletKey = SingleKey.fromPrivateKey(new Uint8Array(32).fill(7))

describe('exit estimate', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('measures real finalized vsizes and prices the full path', async () => {
    const f = await makeSignedExitFixture(1, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)

    const est = estimateExit(temp.db, f.txid, 0, 2)!
    expect(est.proofComplete).toBe(true)
    expect(est.packages).toBe(1)
    expect(est.txs[0]!.vsize).toBeGreaterThan(100) // finalized measurement, not a guess
    expect(est.childVb).toBeGreaterThan(90)
    expect(est.sweepVb).toBeGreaterThan(80) // tapscript input + P2TR output
    expect(est.totalVb).toBe(est.parentVb + est.childVb * est.packages + est.sweepVb)
    expect(est.totalFeeSat).toBe(est.totalVb * 2)
    expect(est.uneconomical).toBe(false) // 10k sats vs ~700 sats of fees
    expect(est.feePctOfValue).toBeGreaterThan(0)
  })

  test('deep chains scale linearly — every hop is another package', async () => {
    const hop = await makeSignedExitFixture(2, { identity: walletKey })
    const f = await makeSignedExitFixture(3, { identity: walletKey })
    // splice a second ARK hop into the vtxo's ancestry
    const chain = [
      f.chain[0]!,
      { txid: hop.txid, type: ChainTxType.ARK, expiresAt: '1783431985', spends: [f.parentTxid] },
      f.chain[1]!,
    ]
    storeVtxoWithProofs(temp.db, { ...f.vtxo, chain }, [...f.proofs, ...hop.proofs])

    const est = estimateExit(temp.db, f.txid, 0, 2)!
    expect(est.packages).toBe(2)
    expect(est.unrollVb).toBe(est.parentVb + est.childVb * 2)
  })

  test('a small vtxo at a high fee rate is flagged uneconomical', async () => {
    const f = await makeSignedExitFixture(4, { identity: walletKey, valueSat: 700 })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)

    const est = estimateExit(temp.db, f.txid, 0, 10)!
    expect(est.totalFeeSat).toBeGreaterThan(700)
    expect(est.uneconomical).toBe(true)
    expect(est.feePctOfValue).toBeGreaterThan(100)
  })

  test('missing proofs are reported, priced parts still shown', async () => {
    const f = await makeSignedExitFixture(5, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, []) // chain known, proof never mirrored

    const est = estimateExit(temp.db, f.txid, 0, 2)!
    expect(est.proofComplete).toBe(false)
    expect(est.packages).toBe(0)
    expect(est.sweepVb).toBeGreaterThan(0) // tapTree is stored, sweep still priced
  })

  test('unknown outpoint → null', () => {
    expect(estimateExit(temp.db, 'f'.repeat(64), 0, 2)).toBeNull()
  })
})
