import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  ChainTxType,
  Unroll,
  type AnchorBumper,
  type OnchainProvider,
  type Transaction,
} from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { makeSignedExitFixture } from '../helpers/exit'
import { storeVtxoWithProofs } from '../../src/exit/vault'
import { VaultIndexer } from '../../src/exit/vault_indexer'

// Session must see every virtual tx as "not yet broadcast" — and stay off
// the network entirely.
const stubExplorer = {
  getTxStatus: async () => {
    throw new Error('not found (stub explorer)')
  },
} as unknown as OnchainProvider

// The real OnchainWallet.bumpP2A broadcasts inside itself; tests must never
// hand Session a real bumper.
const stubBumper: AnchorBumper = {
  bumpP2A: async (parent: Transaction) => [parent.hex, '<dry-run-child>'],
}

describe('vault indexer', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('serves stored proofs in request order', async () => {
    const a = await makeSignedExitFixture(1)
    const b = await makeSignedExitFixture(2)
    storeVtxoWithProofs(temp.db, a.vtxo, a.proofs)
    storeVtxoWithProofs(temp.db, b.vtxo, b.proofs)

    const indexer = new VaultIndexer(temp.db)
    const res = await indexer.getVirtualTxs([b.txid, a.txid])
    expect(res.txs).toEqual([b.psbtB64, a.psbtB64])
  })

  test('a missing proof throws with the txid, never a partial answer', async () => {
    const a = await makeSignedExitFixture(1)
    storeVtxoWithProofs(temp.db, a.vtxo, a.proofs)

    const indexer = new VaultIndexer(temp.db)
    expect(indexer.getVirtualTxs([a.txid, 'f'.repeat(64)])).rejects.toThrow('f'.repeat(64))
  })

  test('getVtxoChain returns the stored chain; unknown outpoints throw', async () => {
    const a = await makeSignedExitFixture(1)
    storeVtxoWithProofs(temp.db, a.vtxo, a.proofs)

    const indexer = new VaultIndexer(temp.db)
    const res = await indexer.getVtxoChain({ txid: a.txid, vout: 0 })
    expect(res.chain).toEqual(a.chain)
    expect(indexer.getVtxoChain({ txid: 'f'.repeat(64), vout: 0 })).rejects.toThrow(
      'no chain',
    )
  })

  test('everything else refuses loudly instead of limping', () => {
    const indexer = new VaultIndexer(temp.db)
    expect(() => indexer.getVtxos()).toThrow('not available offline')
    expect(() => indexer.getSubscription()).toThrow('not available offline')
    expect(() => indexer.getCommitmentTx()).toThrow('not available offline')
  })

  test('drives a real Unroll.Session: ARK entry finalizes via tx.finalize()', async () => {
    const a = await makeSignedExitFixture(1, { chainType: ChainTxType.ARK })
    storeVtxoWithProofs(temp.db, a.vtxo, a.proofs)

    const session = new Unroll.Session(
      { txid: a.txid, vout: 0, chain: a.chain },
      stubBumper,
      stubExplorer,
      new VaultIndexer(temp.db),
    )
    const step = await session.next()
    expect(step.type).toBe(Unroll.StepType.UNROLL)
    if (step.type !== Unroll.StepType.UNROLL) throw new Error('unreachable')
    expect(step.tx.id).toBe(a.txid)
    expect(step.tx.hex.length).toBeGreaterThan(0) // extractable = fully finalized
    expect(step.pkg[0]).toBe(step.tx.hex)
  })

  test('drives a real Unroll.Session: TREE entry finalizes via tapKeySig', async () => {
    const a = await makeSignedExitFixture(3, { chainType: ChainTxType.TREE })
    storeVtxoWithProofs(temp.db, a.vtxo, a.proofs)

    const session = new Unroll.Session(
      { txid: a.txid, vout: 0, chain: a.chain },
      stubBumper,
      stubExplorer,
      new VaultIndexer(temp.db),
    )
    const step = await session.next()
    expect(step.type).toBe(Unroll.StepType.UNROLL)
    if (step.type !== Unroll.StepType.UNROLL) throw new Error('unreachable')
    expect(step.tx.id).toBe(a.txid)
  })

  test('an unmirrored proof surfaces as a loud Session failure', async () => {
    const a = await makeSignedExitFixture(1)
    // vtxo row exists but its proof was never fetched (gap)
    storeVtxoWithProofs(temp.db, a.vtxo, [])

    const session = new Unroll.Session(
      { txid: a.txid, vout: 0, chain: a.chain },
      stubBumper,
      stubExplorer,
      new VaultIndexer(temp.db),
    )
    expect(session.next()).rejects.toThrow('no proof')
  })
})
