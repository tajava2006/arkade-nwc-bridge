import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { base64, hex } from '@scure/base'
import { ChainTxType, Transaction, type ChainTx, type ExtendedVirtualCoin } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import {
  getProofPsbts,
  getVaultVtxo,
  isVtxoExitReady,
  listVaultVtxos,
  vaultStats,
} from '../../src/exit/vault'
import { captureVtxo, syncProofs, type ProofSyncIndexer } from '../../src/exit/proof_sync'
import { createOrRestartExitOp, setExitOpState } from '../../src/exit/ops'
import { makeSpendEvidence } from '../helpers/evidence'

// evidence-gated GC verifies spend signatures against this key; passes where
// nothing disappears never touch it
const PUBKEY = new Uint8Array(32).fill(9)
// fixtures carry expiresAt 1783431985 — a "now" past it makes a
// disappearance locally judged as expired (the no-crypto delete route),
// one before it forces the evidence path. Every disappearance test pins
// nowSec explicitly: the REAL clock eventually passes the fixture expiry,
// and a wall-clock-dependent verdict would rot these tests silently.
const PAST_EXPIRY_NOW = 1783431986
const BEFORE_EXPIRY_NOW = 1700000000

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
  over: Partial<{
    status: string
    batchExpiry: number
    value: number
    commitmentTxIds: string[]
  }> = {},
): ExtendedVirtualCoin {
  return {
    txid: tx.txid,
    vout: 0,
    value: over.value ?? 1000,
    script: '5120' + 'ab'.repeat(32),
    tapTree: hex.decode('c0de'),
    virtualStatus: {
      state: over.status ?? 'preconfirmed',
      batchExpiry: over.batchExpiry ?? 1783431985000, // ms, as the SDK reports it
      ...(over.commitmentTxIds ? { commitmentTxIds: over.commitmentTxIds } : {}),
    },
  } as unknown as ExtendedVirtualCoin
}

interface FakeOpts {
  chains: Record<string, ChainTx[]>
  txs: Map<string, string>
  chainPageSize?: number
  txPageSize?: number
  failVirtualTxs?: boolean
  /** outpoint-keyed rows the fake serves to evidence checks (getVtxos) */
  spentRows?: Record<string, { spentBy?: string; settledBy?: string; state?: string }>
  failGetVtxos?: boolean
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
    async getVtxos({ outpoints }) {
      if (opts.failGetVtxos) throw new Error('indexer 503')
      const vtxos = outpoints.flatMap((o) => {
        const row = opts.spentRows?.[`${o.txid}:${o.vout}`]
        if (!row) return []
        return [
          {
            txid: o.txid,
            vout: o.vout,
            spentBy: row.spentBy,
            settledBy: row.settledBy,
            virtualStatus: { state: row.state ?? 'spent' },
          },
        ]
      })
      return { vtxos: vtxos as never }
    },
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
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark)], PUBKEY)

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
    await syncProofs(temp.db, fake1.indexer, [vtxoOf(ark)], PUBKEY)

    const fake2 = makeFake({
      chains: {
        [`${ark.txid}:0`]: chainOf(ark),
        [`${ark2.txid}:0`]: chainOf(ark2),
      },
      txs: allTxs(),
    })
    const res = await syncProofs(temp.db, fake2.indexer, [vtxoOf(ark), vtxoOf(ark2)], PUBKEY)

    expect(res.skipped).toBe(1) // ark: already complete, zero fetches
    expect(res.synced).toEqual([`${ark2.txid}:0`])
    expect(fake2.virtualTxCalls).toEqual([[ark2.txid]]) // shared branch never refetched
  })

  test('ready vtxo with drifted status refreshes the snapshot without network', async () => {
    const fake = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: allTxs() })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark)], PUBKEY)

    const fake2 = makeFake({ chains: {}, txs: new Map() })
    const res = await syncProofs(temp.db, fake2.indexer, [
      vtxoOf(ark, { status: 'settled' }),
    ], PUBKEY)

    expect(res.skipped).toBe(1)
    expect(fake2.chainCalls()).toBe(0)
    expect(fake2.virtualTxCalls).toEqual([])
    expect(getVaultVtxo(temp.db, ark.txid, 0)!.status).toBe('settled')
  })

  test('per-vtxo isolation: one indexer failure does not block the rest', async () => {
    const good = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: allTxs() })
    await syncProofs(temp.db, good.indexer, [vtxoOf(ark)], PUBKEY)

    // ark2 fetch blows up; ark is already complete
    const flaky = makeFake({
      chains: {
        [`${ark.txid}:0`]: chainOf(ark),
        [`${ark2.txid}:0`]: chainOf(ark2),
      },
      txs: allTxs(),
      failVirtualTxs: true,
    })
    const res = await syncProofs(temp.db, flaky.indexer, [vtxoOf(ark), vtxoOf(ark2)], PUBKEY)

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
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark)], PUBKEY)

    expect(res.failed).toHaveLength(1)
    expect(res.failed[0]!.error).toContain(ark.txid)
    expect(isVtxoExitReady(temp.db, ark.txid, 0)).toBe(false)
    // partial proofs are kept…
    expect(getProofPsbts(temp.db, [checkpoint.txid, tree.txid]).size).toBe(2)

    // …so the retry pass only needs the gap
    const fake2 = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: allTxs() })
    const res2 = await syncProofs(temp.db, fake2.indexer, [vtxoOf(ark)], PUBKEY)
    expect(res2.synced).toEqual([`${ark.txid}:0`])
    expect(fake2.virtualTxCalls).toEqual([[ark.txid]])
    expect(fake2.chainCalls()).toBe(0) // chain reused from the stored row
  })

  test('empty chain response is a failure, not a silently-ready vtxo', async () => {
    const fake = makeFake({ chains: {}, txs: new Map() })
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark)], PUBKEY)
    expect(res.failed[0]!.error).toContain('empty chain')
    expect(getVaultVtxo(temp.db, ark.txid, 0)).toBeNull()
  })

  test('expired + dropped: flagged with the story for review — never silently deleted', async () => {
    const fake = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark), [`${ark2.txid}:0`]: chainOf(ark2) },
      txs: allTxs(),
    })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark), vtxoOf(ark2)], PUBKEY)
    expect(listVaultVtxos(temp.db)).toHaveLength(2)

    // ark vanished and its batch expiry has passed (local clock): the drop
    // is legitimate and nothing is exitable — but the user still gets the
    // explanation + a manual forget, not a silent disappearance
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark2)], PUBKEY, PAST_EXPIRY_NOW)
    expect(res.gc.removedVtxos).toBe(0)
    expect(res.gc.expired).toEqual([`${ark.txid}:0`])
    expect(res.gc.quarantined).toEqual([])
    expect(res.gc.removedProofTxs).toBe(0)
    const row = getVaultVtxo(temp.db, ark.txid, 0)!
    expect(row.quarantinedAt).not.toBeNull()
    expect(row.quarantineReason).toContain('expired')
    // split stats: expired bucket, not the betrayal bucket
    const stats = vaultStats(temp.db, PAST_EXPIRY_NOW)
    expect(stats.expiredCount).toBe(1)
    expect(stats.quarantinedCount).toBe(0)

    // re-confirming passes stay quiet (no re-log churn)
    const res2 = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark2)], PUBKEY, PAST_EXPIRY_NOW)
    expect(res2.gc.expired).toEqual([])
  })

  test('expired but still listed by the server: untouched (recoverable mercy)', async () => {
    const fake = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark) },
      txs: allTxs(),
    })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark)], PUBKEY)

    // expiry passed, but the server keeps returning it (swept-but-recoverable
    // style) — GC only ever judges rows the live set DROPPED
    const res = await syncProofs(
      temp.db,
      fake.indexer,
      [vtxoOf(ark, { status: 'swept' })],
      PUBKEY,
      PAST_EXPIRY_NOW,
    )
    expect(res.gc.removedVtxos).toBe(0)
    expect(res.gc.expired).toEqual([])
    expect(res.gc.quarantined).toEqual([])
    const row = getVaultVtxo(temp.db, ark.txid, 0)!
    expect(row.quarantinedAt).toBeNull()
    expect(row.status).toBe('swept')
  })

  test('unexplained disappearance → quarantine (proofs kept), released when re-listed', async () => {
    const fake = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark), [`${ark2.txid}:0`]: chainOf(ark2) },
      txs: allTxs(),
      // no spentRows: the server won't even acknowledge the outpoint
    })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark), vtxoOf(ark2)], PUBKEY)

    // ark dropped from the live set, expiry NOT passed, no evidence
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark2)], PUBKEY, BEFORE_EXPIRY_NOW)
    expect(res.gc.removedVtxos).toBe(0)
    expect(res.gc.quarantined).toEqual([`${ark.txid}:0`])
    const row = getVaultVtxo(temp.db, ark.txid, 0)!
    expect(row.quarantinedAt).not.toBeNull()
    expect(row.quarantineReason).toContain('no longer acknowledges')
    // proofs survive — the quarantined vtxo is still exitable
    expect(isVtxoExitReady(temp.db, ark.txid, 0)).toBe(true)
    expect(res.gc.removedProofTxs).toBe(0)
    expect(vaultStats(temp.db, BEFORE_EXPIRY_NOW).quarantinedCount).toBe(1)

    // the server re-lists it (glitch, not theft) — quarantine self-heals
    const res2 = await syncProofs(
      temp.db,
      fake.indexer,
      [vtxoOf(ark), vtxoOf(ark2)],
      PUBKEY,
      BEFORE_EXPIRY_NOW,
    )
    expect(res2.gc.released).toEqual([`${ark.txid}:0`])
    expect(getVaultVtxo(temp.db, ark.txid, 0)!.quarantinedAt).toBeNull()
    expect(vaultStats(temp.db, BEFORE_EXPIRY_NOW).quarantinedCount).toBe(0)
  })

  test('verified spend evidence deletes; unverifiable spentBy quarantines until it verifies', async () => {
    // real script-path spend of ark:0 signed by OUR key
    const evidence = makeSpendEvidence(9, { txid: ark.txid, vout: 0 })

    // phase 1: server names the spend but does NOT serve the tx → quarantine
    const withheld = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark), [`${ark2.txid}:0`]: chainOf(ark2) },
      txs: allTxs(),
      spentRows: { [`${ark.txid}:0`]: { spentBy: evidence.spendTxid } },
    })
    await syncProofs(temp.db, withheld.indexer, [vtxoOf(ark), vtxoOf(ark2)], PUBKEY)
    const res = await syncProofs(temp.db, withheld.indexer, [vtxoOf(ark2)], PUBKEY, BEFORE_EXPIRY_NOW)
    expect(res.gc.quarantined).toEqual([`${ark.txid}:0`])
    expect(getVaultVtxo(temp.db, ark.txid, 0)!.quarantineReason).toContain('does not serve')

    // phase 2: the spend tx shows up and OUR signature verifies → delete
    const txsWithEvidence = allTxs()
    txsWithEvidence.set(evidence.spendTxid, evidence.psbtB64)
    const serving = makeFake({
      chains: { [`${ark2.txid}:0`]: chainOf(ark2) },
      txs: txsWithEvidence,
      spentRows: { [`${ark.txid}:0`]: { spentBy: evidence.spendTxid } },
    })
    const res2 = await syncProofs(
      temp.db,
      serving.indexer,
      [vtxoOf(ark2)],
      evidence.pubkey, // the key that actually signed the spend
      BEFORE_EXPIRY_NOW, // still pre-expiry: only the signature justifies deletion
    )
    expect(res2.gc.removedVtxos).toBe(1)
    expect(getVaultVtxo(temp.db, ark.txid, 0)).toBeNull()
  })

  test('spend signed by a FOREIGN key is not evidence → quarantine', async () => {
    // a validly signed spend of the right outpoint — but by someone else's
    // key, so it proves the outpoint moved, not that WE authorized it
    const evidence = makeSpendEvidence(21, { txid: ark.txid, vout: 0 })
    const txs = allTxs()
    txs.set(evidence.spendTxid, evidence.psbtB64)
    const fake = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark), [`${ark2.txid}:0`]: chainOf(ark2) },
      txs,
      spentRows: { [`${ark.txid}:0`]: { spentBy: evidence.spendTxid } },
    })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark), vtxoOf(ark2)], PUBKEY)
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark2)], PUBKEY, BEFORE_EXPIRY_NOW)
    expect(res.gc.removedVtxos).toBe(0)
    expect(res.gc.quarantined).toEqual([`${ark.txid}:0`])
    expect(getVaultVtxo(temp.db, ark.txid, 0)!.quarantineReason).toContain('our signature')
  })

  test('settlement absorption: value conservation deletes without alarm, even past old expiry', async () => {
    // The mainnet 2026-07-27 shape: a refresh consumed a forfeited dust+ vtxo
    // (1000) and a no-forfeit sub-dust vtxo (99) into one fresh 1099 lump.
    // Neither disappeared row carries a signature the per-row machinery could
    // find — the sub-dust one CANNOT (no forfeit exists) — but the round's
    // output exactly accounts for them.
    const round = 'd'.repeat(64)
    const lump = makeProof(5)
    const txs = allTxs()
    txs.set(lump.txid, lump.psbtB64)
    const fake = makeFake({
      chains: {
        [`${ark.txid}:0`]: chainOf(ark),
        [`${ark2.txid}:0`]: chainOf(ark2),
        [`${lump.txid}:0`]: chainOf(lump),
      },
      txs,
      spentRows: {
        [`${ark.txid}:0`]: { settledBy: round, state: 'swept' },
        [`${ark2.txid}:0`]: { settledBy: round, state: 'swept' },
      },
    })
    await syncProofs(
      temp.db,
      fake.indexer,
      [vtxoOf(ark, { value: 1000 }), vtxoOf(ark2, { value: 99 })],
      PUBKEY,
    )
    expect(listVaultVtxos(temp.db)).toHaveLength(2)

    // past the OLD batch expiry on purpose: absorption must win over the
    // expired shortcut, or every late pass re-tells the false lapse story
    const res = await syncProofs(
      temp.db,
      fake.indexer,
      [vtxoOf(lump, { value: 1099, status: 'settled', commitmentTxIds: [round] })],
      PUBKEY,
      PAST_EXPIRY_NOW,
    )
    expect(res.gc.absorbed.sort()).toEqual([`${ark.txid}:0`, `${ark2.txid}:0`].sort())
    expect(res.gc.removedVtxos).toBe(2)
    expect(res.gc.quarantined).toEqual([])
    expect(res.gc.expired).toEqual([])
    expect(getVaultVtxo(temp.db, ark.txid, 0)).toBeNull()
    expect(getVaultVtxo(temp.db, ark2.txid, 0)).toBeNull()
    // the lump itself is mirrored like any live vtxo
    expect(getVaultVtxo(temp.db, lump.txid, 0)).not.toBeNull()
  })

  test('imbalanced conservation (value not accounted for) stays quarantined', async () => {
    // Server claims the sub-dust was settled by a round whose outputs to us
    // do NOT cover it — exactly what a theft dressed up as absorption looks
    // like. The equality fails and the row keeps its proofs.
    const round = 'd'.repeat(64)
    const lump = makeProof(5)
    const txs = allTxs()
    txs.set(lump.txid, lump.psbtB64)
    const fake = makeFake({
      chains: {
        [`${ark2.txid}:0`]: chainOf(ark2),
        [`${lump.txid}:0`]: chainOf(lump),
      },
      txs,
      spentRows: {
        [`${ark2.txid}:0`]: { settledBy: round, state: 'swept' },
      },
    })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark2, { value: 99 })], PUBKEY)

    const res = await syncProofs(
      temp.db,
      fake.indexer,
      [vtxoOf(lump, { value: 1000, status: 'settled', commitmentTxIds: [round] })],
      PUBKEY,
      BEFORE_EXPIRY_NOW,
    )
    expect(res.gc.absorbed).toEqual([])
    expect(res.gc.quarantined).toEqual([`${ark2.txid}:0`])
    expect(getVaultVtxo(temp.db, ark2.txid, 0)!.quarantinedAt).not.toBeNull()
    expect(isVtxoExitReady(temp.db, ark2.txid, 0)).toBe(true)
  })

  test('our own completed exit (op swept) is its own evidence — removed, no alarm', async () => {
    const fake = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark), [`${ark2.txid}:0`]: chainOf(ark2) },
      txs: allTxs(),
      failGetVtxos: true, // classify must never even ask the server
    })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark), vtxoOf(ark2)], PUBKEY)
    createOrRestartExitOp(temp.db, ark.txid, 0)
    setExitOpState(temp.db, ark.txid, 0, 'swept', { sweepTxid: 's'.repeat(64) })

    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark2)], PUBKEY, BEFORE_EXPIRY_NOW)
    expect(res.gc.removedVtxos).toBe(1)
    expect(res.gc.quarantined).toEqual([])
    expect(res.failed).toEqual([])
    expect(getVaultVtxo(temp.db, ark.txid, 0)).toBeNull()
  })

  test('exit in flight (op unrolling): row untouched — sweep still needs it', async () => {
    const fake = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark), [`${ark2.txid}:0`]: chainOf(ark2) },
      txs: allTxs(),
      failGetVtxos: true,
    })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark), vtxoOf(ark2)], PUBKEY)
    createOrRestartExitOp(temp.db, ark.txid, 0) // state: unrolling

    // unrolled onchain → the server no longer lists it, mid-exit
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark2)], PUBKEY, BEFORE_EXPIRY_NOW)
    expect(res.gc.removedVtxos).toBe(0)
    expect(res.gc.quarantined).toEqual([])
    expect(res.failed).toEqual([])
    const row = getVaultVtxo(temp.db, ark.txid, 0)!
    expect(row.quarantinedAt).toBeNull()
    expect(isVtxoExitReady(temp.db, ark.txid, 0)).toBe(true) // proofs intact
  })

  test('a server-shortened expiry cannot fast-forward the expired verdict', async () => {
    const fake = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark), [`${ark2.txid}:0`]: chainOf(ark2) },
      txs: allTxs(),
    })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark), vtxoOf(ark2)], PUBKEY)

    // while still live, the server reports a shortened batch expiry…
    const shortened = BEFORE_EXPIRY_NOW - 100
    await syncProofs(
      temp.db,
      fake.indexer,
      [vtxoOf(ark, { batchExpiry: shortened * 1000 }), vtxoOf(ark2)],
      PUBKEY,
    )
    // …but the stored deadline is monotonic — the original survives
    expect(getVaultVtxo(temp.db, ark.txid, 0)!.expiresAt).toBe(1783431985)

    // now it drops the vtxo at a "now" past the fake expiry but before the
    // real one: NOT expired-deleted — quarantined instead
    const res = await syncProofs(temp.db, fake.indexer, [vtxoOf(ark2)], PUBKEY, BEFORE_EXPIRY_NOW)
    expect(res.gc.removedVtxos).toBe(0)
    expect(res.gc.quarantined).toEqual([`${ark.txid}:0`])
  })

  test('evidence check failure is indeterminate: kept, NOT quarantined', async () => {
    const fake = makeFake({
      chains: { [`${ark.txid}:0`]: chainOf(ark), [`${ark2.txid}:0`]: chainOf(ark2) },
      txs: allTxs(),
    })
    await syncProofs(temp.db, fake.indexer, [vtxoOf(ark), vtxoOf(ark2)], PUBKEY)

    const broken = makeFake({
      chains: { [`${ark2.txid}:0`]: chainOf(ark2) },
      txs: allTxs(),
      failGetVtxos: true,
    })
    const res = await syncProofs(temp.db, broken.indexer, [vtxoOf(ark2)], PUBKEY, BEFORE_EXPIRY_NOW)
    expect(res.gc.removedVtxos).toBe(0)
    expect(res.gc.quarantined).toEqual([])
    expect(res.failed.some((f) => f.outpoint === `${ark.txid}:0`)).toBe(true)
    const row = getVaultVtxo(temp.db, ark.txid, 0)!
    expect(row.quarantinedAt).toBeNull() // our connectivity is not the server's guilt
  })
})

describe('atomic-source rows (#13)', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  const atomicSnapshot = {
    txid: ark.txid,
    vout: 0,
    valueSat: 351, // V = a + dust for a 21-sat swap
    source: 'atomic' as const,
    script: '5120' + 'cd'.repeat(32),
    tapTree: 'c0de',
    status: 'preconfirmed',
    expiresAt: 1783431985,
  }

  test('captureVtxo lands a shared vtxo with source=atomic, exit-ready', async () => {
    const fake = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: allTxs() })
    const res = await captureVtxo(temp.db, fake.indexer, atomicSnapshot)
    expect(res.complete).toBe(true)
    const row = getVaultVtxo(temp.db, ark.txid, 0)
    expect(row?.source).toBe('atomic')
    expect(row?.valueSat).toBe(351)
    expect(isVtxoExitReady(temp.db, ark.txid, 0)).toBe(true)
  })

  test('captureVtxo reports unserved proofs without failing (best-effort mirror)', async () => {
    const fake = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: new Map() })
    const res = await captureVtxo(temp.db, fake.indexer, atomicSnapshot)
    expect(res.complete).toBe(false)
    expect(res.unserved.length).toBeGreaterThan(0)
    // the row still lands — readiness is recomputed, a later pass can top up
    expect(getVaultVtxo(temp.db, ark.txid, 0)?.source).toBe('atomic')
    expect(isVtxoExitReady(temp.db, ark.txid, 0)).toBe(false)
  })

  test('disappearance GC skips atomic rows — no quarantine despite never being in the live set', async () => {
    const fake = makeFake({ chains: { [`${ark.txid}:0`]: chainOf(ark) }, txs: allTxs() })
    await captureVtxo(temp.db, fake.indexer, atomicSnapshot)

    // A pass with an EMPTY live set and an indexer that can't explain the
    // outpoint: a wallet row here would be quarantined as unexplained; the
    // atomic row is lifecycle-owned and must survive untouched.
    const gcFake = makeFake({ chains: {}, txs: new Map() })
    const result = await syncProofs(temp.db, gcFake.indexer, [], PUBKEY, BEFORE_EXPIRY_NOW)
    expect(result.gc.quarantined).toEqual([])
    expect(result.gc.expired).toEqual([])
    expect(result.gc.removedVtxos).toBe(0)
    const row = getVaultVtxo(temp.db, ark.txid, 0)
    expect(row?.quarantinedAt).toBeNull()
    // and its proofs are still referenced (nothing orphan-collected)
    expect(result.gc.removedProofTxs).toBe(0)
  })
})
