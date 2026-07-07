import type { ChainTx } from '@arkade-os/sdk'

// Display-only DAG layout for the exit detail page. NOT a broadcast-order
// fix: arkd's getVtxoChain array (a BFS from the vtxo upward,
// internal/core/application/indexer.go buildVtxoChain) is already a valid
// broadcast order when scanned back-to-front, which is exactly how
// Unroll.Session consumes it — the engine keeps handing Session the raw
// chain. Why the raw order is safe: within a wave, an ark tx is followed by
// its own checkpoints and a tree branch is emitted leaf→root→commitment
// (parents after children in every group); across waves, a checkpoint's
// parent tx is enqueued into the NEXT wave, so it always sits deeper in the
// array. Outpoints have unique spenders, and arkd's visited-set is
// per-outpoint, so a shared ancestor reached through two branches is
// re-emitted at each depth rather than referenced backwards — no
// child-before-parent case exists.
//
// What the BFS shape is NOT, though, is readable: a short branch's
// tree+commitment is inlined wherever the walk reached it, so commitments
// land mid-array. This module recovers the picture from the proof's real
// structure — the `spends` DAG — for rendering: commitments all on the top
// level, every spend edge pointing strictly downward, the vtxo's own tx at
// the bottom. Quirks the edge parsing absorbs (values pass through the SDK
// and the grpc handlers untouched):
//   - checkpoint entries name their parent as an OUTPOINT ("txid:vout"),
//     everything else as a bare txid → strip the index.
//   - commitment entries carry no spends at all (Go zero value omitted).
//   - the per-outpoint dedupe above can emit one tx twice → collapse to one
//     node (also keeps data-step keys unique in the DOM).

export interface ChainEdge {
  parent: string
  child: string
}

export interface ChainGraph {
  /** DAG layers: levels[0] = the commitments … last = the vtxo tx; depth = longest path from a root */
  levels: ChainTx[][]
  /** parent → child spend edges between entries of the chain */
  edges: ChainEdge[]
}

export function chainGraph(chain: ChainTx[]): ChainGraph {
  const nodes: ChainTx[] = []
  const seen = new Set<string>()
  for (const tx of chain) {
    if (seen.has(tx.txid)) continue
    seen.add(tx.txid)
    nodes.push(tx)
  }

  const parents = new Map<string, string[]>()
  for (const tx of nodes) {
    const ps = new Set(
      (tx.spends ?? [])
        .map((s) => s.split(':')[0]!)
        .filter((txid) => txid !== tx.txid && seen.has(txid)),
    )
    parents.set(tx.txid, [...ps])
  }

  // Topological pass (Kahn, wave by wave) purely to resolve parents before
  // children for the depth computation below. Chains are capped at a few
  // thousand entries by proof-sync's paging, so the quadratic ready-scan
  // stays cheap and dependency-free.
  const emitted = new Set<string>()
  const topo: ChainTx[] = []
  while (topo.length < nodes.length) {
    let progressed = false
    for (const tx of nodes) {
      if (emitted.has(tx.txid)) continue
      if (parents.get(tx.txid)!.every((p) => emitted.has(p))) {
        emitted.add(tx.txid)
        topo.push(tx)
        progressed = true
      }
    }
    if (!progressed) {
      // cycle or self-referential garbage: emit the rest as-is — a degraded
      // display beats an unrenderable emergency page
      for (const tx of nodes) {
        if (!emitted.has(tx.txid)) {
          emitted.add(tx.txid)
          topo.push(tx)
        }
      }
    }
  }

  // Longest path from a root: commitments share the top level, a short
  // branch stays near the top with long edges down to its merge point, a
  // deep branch fills every level on the way down.
  const depth = new Map<string, number>()
  for (const tx of topo) {
    const ps = parents.get(tx.txid)!
    depth.set(tx.txid, ps.length === 0 ? 0 : 1 + Math.max(...ps.map((p) => depth.get(p) ?? 0)))
  }
  const byDepth: ChainTx[][] = []
  for (const tx of topo) {
    const d = depth.get(tx.txid)!
    ;(byDepth[d] ??= []).push(tx)
  }
  const levels = byDepth.filter((l) => l !== undefined && l.length > 0)

  const edges: ChainEdge[] = []
  for (const tx of nodes) {
    for (const p of parents.get(tx.txid)!) {
      edges.push({ parent: p, child: tx.txid })
    }
  }

  return { levels, edges }
}
