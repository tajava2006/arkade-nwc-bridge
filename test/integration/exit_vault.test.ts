import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ChainTxType, type ChainTx } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import {
  clearQuarantine,
  gcOrphanProofs,
  getProofPsbts,
  getVaultVtxo,
  isVtxoExitReady,
  listMaturedBetrayals,
  listVaultVtxos,
  missingProofTxids,
  proofTxidsOf,
  quarantineVtxo,
  removeVtxo,
  storeVtxoWithProofs,
  vaultStats,
  type VaultProofTx,
  type VaultVtxoSnapshot,
} from '../../src/exit/vault'

const tx = (txid: string, type: ChainTxType, spends: string[] = []): ChainTx => ({
  txid,
  type,
  expiresAt: '1783431985',
  spends,
})

const proof = (txid: string, type: ChainTxType): VaultProofTx => ({
  txid,
  type,
  psbtB64: `psbt-of-${txid}`,
})

// chain layout mirrors the real indexer shape: vtxo's own ark tx first,
// commitment last; only ARK/CHECKPOINT/TREE entries need proofs
const chainA: ChainTx[] = [
  tx('a-ark', ChainTxType.ARK, ['shared-checkpoint']),
  tx('shared-checkpoint', ChainTxType.CHECKPOINT, ['shared-tree']),
  tx('shared-tree', ChainTxType.TREE, ['commitment-1']),
  tx('commitment-1', ChainTxType.COMMITMENT),
]
const chainB: ChainTx[] = [
  tx('b-ark', ChainTxType.ARK, ['shared-checkpoint']),
  tx('shared-checkpoint', ChainTxType.CHECKPOINT, ['shared-tree']),
  tx('shared-tree', ChainTxType.TREE, ['commitment-1']),
  tx('commitment-1', ChainTxType.COMMITMENT),
]

const vtxo = (txid: string, chain: ChainTx[], value = 1000): VaultVtxoSnapshot => ({
  txid,
  vout: 0,
  valueSat: value,
  source: 'wallet',
  script: '5120' + 'ab'.repeat(32),
  tapTree: 'c0de',
  status: 'preconfirmed',
  expiresAt: 1783431985,
  chain,
})

const proofsFor = (chain: ChainTx[]): VaultProofTx[] =>
  chain
    .filter((c) => c.type !== ChainTxType.COMMITMENT)
    .map((c) => proof(c.txid, c.type))

describe('exit vault', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('stores and round-trips a vtxo with its chain', () => {
    storeVtxoWithProofs(temp.db, vtxo('a-ark', chainA), proofsFor(chainA))

    const got = getVaultVtxo(temp.db, 'a-ark', 0)
    expect(got).not.toBeNull()
    expect(got!.valueSat).toBe(1000)
    expect(got!.tapTree).toBe('c0de')
    expect(got!.expiresAt).toBe(1783431985)
    expect(got!.chain).toEqual(chainA)
    expect(isVtxoExitReady(temp.db, 'a-ark', 0)).toBe(true)
  })

  test('proofTxidsOf excludes commitment-level entries', () => {
    expect(proofTxidsOf(chainA)).toEqual(['a-ark', 'shared-checkpoint', 'shared-tree'])
  })

  test('shared branches are stored once and survive either owner', () => {
    storeVtxoWithProofs(temp.db, vtxo('a-ark', chainA), proofsFor(chainA))
    storeVtxoWithProofs(temp.db, vtxo('b-ark', chainB), proofsFor(chainB))

    // 6 proof refs across the two chains, 4 unique rows
    expect(vaultStats(temp.db).proofTxCount).toBe(4)

    // first copy wins on conflict — re-storing with different bytes is ignored
    storeVtxoWithProofs(temp.db, vtxo('a-ark', chainA), [
      { txid: 'shared-tree', type: ChainTxType.TREE, psbtB64: 'tampered' },
    ])
    expect(getProofPsbts(temp.db, ['shared-tree']).get('shared-tree')).toBe('psbt-of-shared-tree')
  })

  test('readiness is recomputed from stored proofs, not the row itself', () => {
    // vtxo row lands before all proofs have been fetched
    storeVtxoWithProofs(temp.db, vtxo('a-ark', chainA), [proof('a-ark', ChainTxType.ARK)])
    expect(isVtxoExitReady(temp.db, 'a-ark', 0)).toBe(false)
    expect(missingProofTxids(temp.db, chainA)).toEqual(['shared-checkpoint', 'shared-tree'])

    // late proofs complete it
    storeVtxoWithProofs(temp.db, vtxo('a-ark', chainA), [
      proof('shared-checkpoint', ChainTxType.CHECKPOINT),
      proof('shared-tree', ChainTxType.TREE),
    ])
    expect(isVtxoExitReady(temp.db, 'a-ark', 0)).toBe(true)
    expect(missingProofTxids(temp.db, chainA)).toEqual([])
  })

  test('removeVtxo + gcOrphanProofs drop exclusive proofs, keep shared ones', () => {
    storeVtxoWithProofs(temp.db, vtxo('a-ark', chainA), proofsFor(chainA))
    storeVtxoWithProofs(temp.db, vtxo('b-ark', chainB), proofsFor(chainB))

    // a-ark's disappearance was evidence-verified upstream; drop it
    expect(removeVtxo(temp.db, 'a-ark', 0)).toBe(true)
    expect(gcOrphanProofs(temp.db)).toBe(1) // a-ark's own ark tx; shared branch stays

    expect(getVaultVtxo(temp.db, 'a-ark', 0)).toBeNull()
    expect(isVtxoExitReady(temp.db, 'b-ark', 0)).toBe(true)
    const psbts = getProofPsbts(temp.db, ['a-ark', 'shared-checkpoint', 'shared-tree', 'b-ark'])
    expect(psbts.has('a-ark')).toBe(false)
    expect(psbts.has('shared-checkpoint')).toBe(true)
  })

  test('quarantine keeps the row, its proofs, and the FIRST flag time', () => {
    storeVtxoWithProofs(temp.db, vtxo('a-ark', chainA), proofsFor(chainA))

    quarantineVtxo(temp.db, 'a-ark', 0, 'first reason')
    const first = getVaultVtxo(temp.db, 'a-ark', 0)!
    expect(first.quarantinedAt).not.toBeNull()
    expect(first.quarantineReason).toBe('first reason')

    // re-quarantine on a later pass: reason refreshes, timestamp does not
    quarantineVtxo(temp.db, 'a-ark', 0, 'second reason')
    const again = getVaultVtxo(temp.db, 'a-ark', 0)!
    expect(again.quarantinedAt).toBe(first.quarantinedAt)
    expect(again.quarantineReason).toBe('second reason')

    // proofs untouched — the row still counts as a reference
    expect(gcOrphanProofs(temp.db)).toBe(0)
    expect(isVtxoExitReady(temp.db, 'a-ark', 0)).toBe(true)

    // stats: out of the live/ready math, into its own counter — and the
    // bucket depends on whether the exit window is still open
    const stats = vaultStats(temp.db, 1700000000) // before fixture expiry
    expect(stats.vtxoCount).toBe(0)
    expect(stats.readyCount).toBe(0)
    expect(stats.quarantinedCount).toBe(1)
    expect(stats.expiredCount).toBe(0)
    // …but the expiry clock still counts it (exit-before-expiry pressure)
    expect(stats.soonestExpiresAt).toBe(1783431985)
    // once the window closes, the same row reads as expired-for-review
    const later = vaultStats(temp.db, 1783431986)
    expect(later.quarantinedCount).toBe(0)
    expect(later.expiredCount).toBe(1)

    // snapshot refresh (upsert) must not wipe the flag
    storeVtxoWithProofs(temp.db, { ...vtxo('a-ark', chainA), status: 'spent' }, [])
    expect(getVaultVtxo(temp.db, 'a-ark', 0)!.quarantinedAt).toBe(first.quarantinedAt)

    expect(clearQuarantine(temp.db, 'a-ark', 0)).toBe(true)
    expect(getVaultVtxo(temp.db, 'a-ark', 0)!.quarantinedAt).toBeNull()
    expect(clearQuarantine(temp.db, 'a-ark', 0)).toBe(false) // idempotent signal
    expect(vaultStats(temp.db, 1700000000).quarantinedCount).toBe(0)
  })

  test('upsert replaces the vtxo snapshot in place', () => {
    storeVtxoWithProofs(temp.db, vtxo('a-ark', chainA), proofsFor(chainA))
    storeVtxoWithProofs(temp.db, { ...vtxo('a-ark', chainA, 2222), status: 'settled' }, [])

    const got = getVaultVtxo(temp.db, 'a-ark', 0)
    expect(got!.valueSat).toBe(2222)
    expect(got!.status).toBe('settled')
    expect(listVaultVtxos(temp.db)).toHaveLength(1)
  })

  test('stats summarize readiness, size and deadlines', () => {
    storeVtxoWithProofs(temp.db, vtxo('a-ark', chainA), proofsFor(chainA))
    storeVtxoWithProofs(
      temp.db,
      { ...vtxo('b-ark', chainB), expiresAt: 1700000000 },
      [proof('b-ark', ChainTxType.ARK)], // shared proofs already stored by chainA
    )

    const stats = vaultStats(temp.db)
    expect(stats.vtxoCount).toBe(2)
    expect(stats.readyCount).toBe(2) // b-ark's remaining proofs are the shared ones
    expect(stats.proofTxCount).toBe(4)
    expect(stats.proofBytes).toBeGreaterThan(0)
    expect(stats.soonestExpiresAt).toBe(1700000000)
    expect(stats.lastSyncedAt).not.toBeNull()
  })
})

describe('listMaturedBetrayals (betrayal-DM grace gate)', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  // 2096 — safely past any real/test clock so these rows read as betrayal
  // (window open), not expired-window.
  const FUTURE = 4_000_000_000

  test('a betrayal quarantine matures only once its flag is >= grace old', () => {
    storeVtxoWithProofs(temp.db, { ...vtxo('a-ark', chainA), expiresAt: FUTURE }, proofsFor(chainA))
    quarantineVtxo(temp.db, 'a-ark', 0, 'indexer no longer acknowledges the outpoint')
    const at = getVaultVtxo(temp.db, 'a-ark', 0)!.quarantinedAt!

    expect(listMaturedBetrayals(temp.db, 100, at)).toEqual([]) // age 0
    expect(listMaturedBetrayals(temp.db, 100, at + 99)).toEqual([]) // age 99 < 100
    expect(listMaturedBetrayals(temp.db, 100, at + 100)).toEqual([
      { outpoint: 'a-ark:0', reason: 'indexer no longer acknowledges the outpoint' },
    ])
  })

  test('an expired-window flag is excluded (it owns a separate immediate DM)', () => {
    storeVtxoWithProofs(temp.db, { ...vtxo('b-ark', chainB), expiresAt: 1_700_000_000 }, proofsFor(chainB))
    quarantineVtxo(temp.db, 'b-ark', 0, 'batch expired before a refresh and the server dropped it')
    const at = getVaultVtxo(temp.db, 'b-ark', 0)!.quarantinedAt!
    // well past grace, but expiresAt (1.7e9) <= now → not a betrayal alarm
    expect(listMaturedBetrayals(temp.db, 100, Math.max(at + 1000, 1_800_000_000))).toEqual([])
  })

  test('a non-quarantined row is never matured, even at grace 0', () => {
    storeVtxoWithProofs(temp.db, { ...vtxo('c-ark', chainA), expiresAt: FUTURE }, proofsFor(chainA))
    expect(listMaturedBetrayals(temp.db, 0, FUTURE - 1)).toEqual([])
  })
})
