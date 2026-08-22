import { describe, expect, test } from 'bun:test'
import { ChainTxType, type ChainTx } from '@arkade-os/sdk'
import { chainGraph, danglingEntries, parentTxids } from '../../src/exit/chain_order'

// F22: a stored chain that names an ancestor it doesn't contain is unexitable,
// and used to be invisible — proof completeness only asks about txs the chain
// already lists, and proof_sync never re-fetched a chain it had. These pin the
// detector that closes both halves.

const t = (txid: string, type: ChainTxType, spends: string[] = []): ChainTx =>
  ({ txid, type, expiresAt: '0', spends }) as ChainTx

/** Shaped like arkd's walk: ark spends bare checkpoint ids, checkpoints spend an outpoint. */
const whole = (): ChainTx[] => [
  t('ARK1', ChainTxType.ARK, ['CP1']),
  t('CP1', ChainTxType.CHECKPOINT, ['LEAF:0']),
  t('LEAF', ChainTxType.TREE, ['ROOT']),
  t('ROOT', ChainTxType.TREE, ['COMMIT']),
  t('COMMIT', ChainTxType.COMMITMENT),
]

describe('parentTxids', () => {
  test('strips the vout a checkpoint names its parent with', () => {
    expect(parentTxids(t('CP', ChainTxType.CHECKPOINT, ['PARENT:0']))).toEqual(['PARENT'])
  })
  test('takes bare txids as-is and de-dupes', () => {
    expect(parentTxids(t('A', ChainTxType.ARK, ['X', 'Y', 'X']))).toEqual(['X', 'Y'])
  })
  test('ignores blanks and self-references', () => {
    expect(parentTxids(t('A', ChainTxType.ARK, ['', '  ', 'A']))).toEqual([])
  })
  test('a commitment names nothing', () => {
    expect(parentTxids(t('C', ChainTxType.COMMITMENT))).toEqual([])
  })
})

describe('danglingEntries', () => {
  test('a whole chain has none', () => {
    expect(danglingEntries(whole())).toEqual([])
  })

  test('a commitment is a root, never a dangle', () => {
    expect(danglingEntries([t('COMMIT', ChainTxType.COMMITMENT)])).toEqual([])
  })

  test('flags the entry whose ancestor is missing — the mainnet shape', () => {
    // The 58,863-sat vtxo: a checkpoint whose parent VTXO never made it in.
    const broken = whole().filter((c) => c.txid !== 'LEAF')
    expect(danglingEntries(broken).map((c) => c.txid)).toEqual(['CP1'])
  })

  test('flags an ARK whose checkpoint is missing — the other mainnet shape', () => {
    // The 2,000-sat vtxo. Structurally impossible for today's indexer to emit
    // (it appends an ark tx and its checkpoints together), which is what dated
    // that capture to an older one.
    const broken = whole().filter((c) => c.txid !== 'CP1')
    expect(danglingEntries(broken).map((c) => c.txid)).toEqual(['ARK1'])
  })

  test('a multi-parent entry survives on one resolvable parent', () => {
    // Only ALL parents missing is a break: a merge tx whose other branch is
    // present is still reachable.
    const chain = [
      t('ARK1', ChainTxType.ARK, ['CPa', 'CPb']),
      t('CPa', ChainTxType.CHECKPOINT, ['COMMIT:0']),
      t('COMMIT', ChainTxType.COMMITMENT),
    ]
    expect(danglingEntries(chain).map((c) => c.txid)).toEqual([])
  })

  test("arkd's duplicate entries don't create phantom dangles", () => {
    const dup = [...whole(), t('CP1', ChainTxType.CHECKPOINT, ['LEAF:0'])]
    expect(danglingEntries(dup)).toEqual([])
  })
})

describe('chainGraph layout follows from the same rule', () => {
  test('a whole chain puts the commitment alone on top', () => {
    const levels = chainGraph(whole()).levels
    expect(levels[0]!.map((c) => c.txid)).toEqual(['COMMIT'])
  })

  test('a break lifts the orphan onto the commitment row — the reported symptom', () => {
    // This is what "checkpoint at the very top, settlement below it" was: not
    // a layout bug, an input with a hole. Kept as a regression so a future
    // layout change can't quietly re-explain it.
    const levels = chainGraph(whole().filter((c) => c.txid !== 'LEAF')).levels
    expect(levels[0]!.map((c) => c.txid).sort()).toEqual(['COMMIT', 'CP1'])
  })
})
