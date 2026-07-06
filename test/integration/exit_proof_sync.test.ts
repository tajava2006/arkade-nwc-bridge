import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { base64, hex } from '@scure/base'
import { ChainTxType, Transaction, type ChainTx, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { getProofPsbts, getVaultVtxo, isVtxoExitReady, listVaultVtxos } from '../../src/exit/vault'
import { syncProofs, type ProofSyncIndexer } from '../../src/exit/proof_sync'

// syncProofs verifies proofs by DECODING them (label = payload's own txid),
// so fixtures must be real PSBTs — a skeletal unsigned tx with a P2A-style
// output is enough to round-trip Transaction.fromPSBT and yield a stable id.
function makeProof(seedByte: number): { txid: string; psbtB64: string } {
  const tx = new Transaction({ allowUnknownOutputs: true })
  tx.addInput({ txid: new Uint8Array(32).fill(seedByte), index: 0 })
  tx.addOutput({ script: hex.decode('51024e73'), amount: 0n })
  return { txid: tx.id, psbtB64: base64.encode(tx.toPSBT()) }
}

const ark = makeProof(1)
const checkpoint = makeProof(2)
const tree = makeProof(3)
const ark2 = makeProof(4)

const COMMITMENT_TXID = 'c'.repeat(64)

function chainOf(vtxoTx: { txid: string }, shared = true): ChainTx[] {
  const mk = (txid: string, type: ChainTxType, spends: string[]): ChainTx => ({
    txid,
    type,
    expiresAt: '1783431985',
    spends,
  })
  return [
    mk(vtxoTx.txid, ChainTxType.ARK, [checkpoint.txid]),
    ...(shared
      ? [
          mk(checkpoint.txid, ChainTxType.CHECKPOINT, [tree.txid]),
          mk(tree.txid, ChainTxType.TREE, [COMMITMENT_TXID]),
        ]
      : []),
    mk(COMMITMENT_TXID, ChainTxType.COMMITMENT, []),
  ]
}

function vtxoOf(
  tx: { txid: string },
  over: Partial<{ status: string; batchExpiry: number }> = {},
): ExtendedVirtualCoin {
  return {
    txid: tx.txid,
    vout: 0,
    value: 1000,
    script: '5120' + 'ab'.repeat(32),
    tapTree: hex.decode('c0de'),
    virtualStatus: {
      state: over.status ?? 'preconfirmed',
      batchExpiry: over.batchExpiry ?? 1783431985000, // ms, as the SDK reports it
    },
  } as unknown as ExtendedVirtualCoin
}

interface FakeOpts {
  chains: Record<string, ChainTx[]>
  txs: Map<string, string>
  chainPageSize?: number
  txPageSize?: number
  failVirtualTxs?: boolean
}

function makeFake(opts: FakeOpts) {
  const virtualTxCalls: string[][] = []
  let chainCalls = 0
  const paginate = <T>(items: T[], size: number, pageIndex: number) => {
    const pages = Math.max(1, Math.ceil(items.length / size))
    const current = Math.min(pageIndex, pages - 1)
    return {
      slice: items.slice(current * size, (current + 1) * size),
      // last page: next stays put — the "doesn't advance" sentinel
      page: { current, next: current + 1 < pages ? current + 1 : current, total: pages },
    }
  }
  const indexer: ProofSyncIndexer = {
    async getVtxoChain(outpoint, o) {
      chainCalls++
      const chain = opts.chains[`${outpoint.txid}:${outpoint.vout}`] ?? []
      const { slice, page } = paginate(chain, opts.chainPageSize ?? 100, o?.pageIndex ?? 0)
      return { chain: slice, page }
    },
    async getVirtualTxs(txids, o) {
      if (opts.failVirtualTxs) throw new Error('indexer 502')
      virtualTxCalls.push([...txids])
      const found = txids.map((id) => opts.txs.get(id)).filter((x): x is string => !!x)
      const { slice, page } = paginate(found, opts.txPageSize ?? 100, o?.pageIndex ?? 0)
      return { txs: slice, page }
    },
  }
  return { indexer, virtualTxCalls, chainCalls: () => chainCalls }
}

const allTxs = () =>
  new Map([
    [ark.txid, ark.psbtB64],
    [checkpoint.txid, checkpoint.psbtB64],
    [tree.txid, tree.psbtB64],
    [ark2.txid, ark2.psbtB64],
  ])

describe('proof sync', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('new vtxo: paged chain + paged proofs land in the vault, ready', async () => {
    const fake = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark) },
      txs: allTxs(),
      chainPageSize: 2, // 4 chain entries → 2 pages
      txPageSize: 2, // 3 proofs → 2 pages
    })
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark)])

    expect(res.synced).toEqual([`${ark.txid}:0`])
    expect(res.failed).toEqual([])
    expect(fake.chainCalls()).toBe(2)
    expect(isVtxoExitReady(temp.db, ark.txid, 0)).toBe(true)
    const stored = getVaultVtxo(temp.db, ark.txid, 0)!
    expect(stored.chain).toHaveLength(4)
    expect(stored.expiresAt).toBe(1783431985) // ms → sec
    expect(stored.tapTree).toBe('c0de')
  })

  test('shared branch: second vtxo only fetches its own missing txid', async () => {
    const fake1 = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: allTxs() })
    await syncProofs(temp.db, fake1.indexer, [vtxoOf(ark)])

    const fake2 = makeFake({
      chains: {
        [`${ark.txid}:0`]: chainOf(ark),
        [`${ark2.txid}:0`]: chainOf(ark2),
      },
      txs: allTxs(),
    })
    const res = await syncProofs(temp.db, fake2.indexer, [vtxoOf(ark), vtxoOf(ark2)])

    expect(res.skipped).toBe(1) // ark: already complete, zero fetches
    expect(res.synced).toEqual([`${ark2.txid}:0`])
    expect(fake2.virtualTxCalls).toEqual([[ark2.txid]]) // shared branch never refetched
  })

  test('ready vtxo with drifted status refreshes the snapshot without network', async () => {
    const fake = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: allTxs() })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark)])

    const fake2 = makeFake({ chains: {}, txs: new Map() })
    const res = await syncProofs(temp.db, fake2.indexer, [
      vtxoOf(ark, { status: 'settled' }),
    ])

    expect(res.skipped).toBe(1)
    expect(fake2.chainCalls()).toBe(0)
    expect(fake2.virtualTxCalls).toEqual([])
    expect(getVaultVtxo(temp.db, ark.txid, 0)!.status).toBe('settled')
  })

  test('per-vtxo isolation: one indexer failure does not block the rest', async () => {
    const good = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: allTxs() })
    await syncProofs(temp.db, good.indexer, [vtxoOf(ark)])

    // ark2 fetch blows up; ark is already complete
    const flaky = makeFake({
      chains: {
        [`${ark.txid}:0`]: chainOf(ark),
        [`${ark2.txid}:0`]: chainOf(ark2),
      },
      txs: allTxs(),
      failVirtualTxs: true,
    })
    const res = await syncProofs(temp.db, flaky.indexer, [vtxoOf(ark), vtxoOf(ark2)])

    expect(res.skipped).toBe(1)
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0]!.outpoint).toBe(`${ark2.txid}:0`)
    expect(isVtxoExitReady(temp.db, ark.txid, 0)).toBe(true)
  })

  test('unserved / mislabeled proofs: store what arrived, report the gap, next pass completes', async () => {
    // server "serves" the request but the payload for ark's own txid is
    // missing — decode-keyed mapping refuses to file anything under it
    const txsMissingOne = allTxs()
    txsMissingOne.delete(ark.txid)
    const fake = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: txsMissingOne })
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark)])

    expect(res.failed).toHaveLength(1)
    expect(res.failed[0]!.error).toContain(ark.txid)
    expect(isVtxoExitReady(temp.db, ark.txid, 0)).toBe(false)
    // partial proofs are kept…
    expect(getProofPsbts(temp.db, [checkpoint.txid, tree.txid]).size).toBe(2)

    // …so the retry pass only needs the gap
    const fake2 = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: allTxs() })
    const res2 = await syncProofs(temp.db, fake2.indexer, [vtxoOf(ark)])
    expect(res2.synced).toEqual([`${ark.txid}:0`])
    expect(fake2.virtualTxCalls).toEqual([[ark.txid]])
    expect(fake2.chainCalls()).toBe(0) // chain reused from the stored row
  })

  test('empty chain response is a failure, not a silently-ready vtxo', async () => {
    const fake = makeFake({ chains: {}, txs: new Map() })
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark)])
    expect(res.failed[0]!.error).toContain('empty chain')
    expect(getVaultVtxo(temp.db, ark.txid, 0)).toBeNull()
  })

  test('gc drops vault rows the live set no longer contains', async () => {
    const fake = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark), [`${ark2.txid}:0`]: chainOf(ark2) },
      txs: allTxs(),
    })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark), vtxoOf(ark2)])
    expect(listVaultVtxos(temp.db)).toHaveLength(2)

    // ark got spent — next pass only lists ark2
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark2)])
    expect(res.gc.removedVtxos).toBe(1)
    expect(res.gc.removedProofTxs).toBe(1) // ark's own tx; shared branch survives
    expect(getVaultVtxo(temp.db, ark.txid, 0)).toBeNull()
    expect(isVtxoExitReady(temp.db, ark2.txid, 0)).toBe(true)
  })
})
