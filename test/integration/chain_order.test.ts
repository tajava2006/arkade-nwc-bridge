import { describe, expect, test } from 'bun:test'
import { ChainTxType, type ChainTx } from '@arkade-os/sdk'
import { chainGraph } from '../../src/exit/chain_order'

const mk = (txid: string, type: ChainTxType, spends: string[] = []): ChainTx => ({
  txid,
  type,
  expiresAt: '',
  spends,
})

// The exact shape arkd's BFS emits for a two-branch history (see
// buildVtxoChain): leaf-side first, and the SHORT branch's tree+commitment
// inlined mid-array while the long branch is still being walked. This is the
// mainnet observation that motivated the module — a commitment sitting in
// the middle of 144 entries. (The array is still a valid broadcast order
// back-to-front; the layout is what needs recovering.)
//
//   C1 → T0 → T1 ─(k1: spends "T1:0")─┐
//                                     L (ark, spends k1+k2)
//   C2 → T2 ─(k3)─ B2 ─(k2)───────────┘
function arkdBfsFixture(): ChainTx[] {
  return [
    mk('L', ChainTxType.ARK, ['k1', 'k2']),
    mk('k1', ChainTxType.CHECKPOINT, ['T1:0']),
    mk('k2', ChainTxType.CHECKPOINT, ['B2:1']),
    mk('T1', ChainTxType.TREE, ['T0']),
    mk('T0', ChainTxType.TREE, ['C1']),
    mk('C1', ChainTxType.COMMITMENT),
    mk('B2', ChainTxType.ARK, ['k3']),
    mk('k3', ChainTxType.CHECKPOINT, ['T2:0']),
    mk('T2', ChainTxType.TREE, ['C2']),
    mk('C2', ChainTxType.COMMITMENT),
  ]
}

describe('chainGraph', () => {
  test('levels: all commitments share the top, the vtxo tx sits alone at the bottom', () => {
    const g = chainGraph(arkdBfsFixture())
    const ids = g.levels.map((l) => l.map((tx) => tx.txid))
    expect(ids[0]).toEqual(['C1', 'C2'])
    expect(ids[ids.length - 1]).toEqual(['L'])
  })

  test('every spend edge points strictly downward across levels', () => {
    const g = chainGraph(arkdBfsFixture())
    const levelOf = new Map<string, number>()
    g.levels.forEach((row, d) => row.forEach((tx) => levelOf.set(tx.txid, d)))
    expect(g.edges.length).toBeGreaterThan(0)
    for (const e of g.edges) {
      expect(levelOf.get(e.parent)!).toBeLessThan(levelOf.get(e.child)!)
    }
  })

  test('a short branch keeps its commitment on top and bridges down with long edges', () => {
    const g = chainGraph(arkdBfsFixture())
    const levelOf = new Map<string, number>()
    g.levels.forEach((row, d) => row.forEach((tx) => levelOf.set(tx.txid, d)))
    // short branch ends at k1 (depth 3); the merge point L sits at depth 5 —
    // the k1→L edge spans levels instead of dragging C1 down mid-graph
    expect(levelOf.get('C1')).toBe(0)
    expect(levelOf.get('L')! - levelOf.get('k1')!).toBeGreaterThan(1)
  })

  test('checkpoint outpoint-style spends ("txid:vout") resolve to edges', () => {
    const g = chainGraph(arkdBfsFixture())
    expect(g.edges).toContainEqual({ parent: 'T1', child: 'k1' })
    expect(g.edges).toContainEqual({ parent: 'B2', child: 'k2' })
  })

  test('duplicate txids (arkd dedupes per outpoint, not per tx) collapse to one node', () => {
    const g = chainGraph([
      mk('A', ChainTxType.ARK, ['C']),
      mk('A', ChainTxType.ARK, ['C']),
      mk('C', ChainTxType.COMMITMENT),
    ])
    expect(g.levels.map((l) => l.map((tx) => tx.txid))).toEqual([['C'], ['A']])
  })

  test('cycle garbage falls back to input order instead of hanging', () => {
    const g = chainGraph([
      mk('X', ChainTxType.ARK, ['Y']),
      mk('Y', ChainTxType.ARK, ['X']),
    ])
    expect(g.levels.flat().map((tx) => tx.txid).sort()).toEqual(['X', 'Y'])
  })

  test('plain two-entry chain keeps its obvious shape', () => {
    const g = chainGraph([mk('v', ChainTxType.ARK, ['c']), mk('c', ChainTxType.COMMITMENT)])
    expect(g.levels.map((l) => l.map((tx) => tx.txid))).toEqual([['c'], ['v']])
    expect(g.edges).toEqual([{ parent: 'c', child: 'v' }])
  })
})

// Lanes: two commitments a vtxo descends from are independent work, so they
// belong side by side, not flattened into one column that re-centres every
// row (which made the edges zig-zag and the whole thing read as a single
// line).
describe('chainGraph lanes', () => {
  test('independent roots get their own lane, and each branch runs straight down', () => {
    const g = chainGraph(arkdBfsFixture())
    expect(g.width).toBe(2)
    // the two roots split
    expect(g.lane.get('C1')).not.toBe(g.lane.get('C2'))
    // and each branch keeps its root's lane the whole way down
    for (const txid of ['T0', 'T1', 'k1']) expect(g.lane.get(txid)).toBe(g.lane.get('C1')!)
    for (const txid of ['T2', 'k3', 'B2', 'k2']) expect(g.lane.get(txid)).toBe(g.lane.get('C2')!)
  })

  test('a merge sits under its leftmost parent, keeping the trunk in lane 0', () => {
    const g = chainGraph(arkdBfsFixture())
    expect(g.lane.get('L')).toBe(Math.min(g.lane.get('k1')!, g.lane.get('k2')!))
  })

  test('a single-branch chain stays one lane wide', () => {
    const g = chainGraph([
      mk('A', ChainTxType.ARK, ['k']),
      mk('k', ChainTxType.CHECKPOINT, ['T:0']),
      mk('T', ChainTxType.TREE, ['C']),
      mk('C', ChainTxType.COMMITMENT),
    ])
    expect(g.width).toBe(1)
    expect([...g.lane.values()].every((l) => l === 0)).toBe(true)
  })

  test('every lane is a real integer column, and no two nodes share one per level', () => {
    const g = chainGraph(arkdBfsFixture())
    for (const level of g.levels) {
      const lanes = level.map((tx) => g.lane.get(tx.txid)!)
      expect(lanes.every((l) => Number.isInteger(l) && l >= 0 && l < g.width)).toBe(true)
      expect(new Set(lanes).size).toBe(lanes.length)
    }
  })
})
