import type { IndexerProvider } from '@arkade-os/sdk'
import { chainGraph } from '../exit/chain_order'

// A VHTLC's on-chain fallback is timed for a bounded unroll (vhtlc.ts U), and a
// vtxo's unroll takes one block per level of its ancestry (TRUC: one
// unconfirmed parent at a time). Chains grow by two levels per offchain spend
// and only a refresh resets them — 51 levels seen on mainnet 2026-11-28 — so
// both sides cap the depth of what funds a VHTLC.

/** Levels of a vtxo's ancestry that would need broadcasting (the commitment is already on chain). */
export async function vtxoUnrollDepth(indexer: IndexerProvider, outpoint: { txid: string; vout: number }): Promise<number> {
  // One request, no paging: arkd re-walks the chain per page, and stitching pages
  // from different walks once left holes in our proofs (SUBDUST_ATOMIC_SECURITY_REVIEW F22).
  const { chain } = await indexer.getVtxoChain(outpoint)
  return chainGraph(chain).levels.length - 1
}

/**
 * Run `pick` over `pool`, but never return a coin deeper than `cap`: a
 * too-deep pick is dropped from the pool and the pick rerun. One chain read
 * per picked coin, memoized across reruns. [] when nothing within the cap covers.
 */
export async function selectWithinDepthCap<T extends { txid: string; vout: number }>(
  pool: T[],
  pick: (pool: T[]) => T[],
  indexer: IndexerProvider,
  cap: number,
): Promise<T[]> {
  const depth = new Map<string, number>()
  const key = (c: T) => `${c.txid}:${c.vout}`
  for (;;) {
    const picked = pick(pool)
    if (picked.length === 0) return []
    const deep = new Set<string>()
    for (const c of picked) {
      let d = depth.get(key(c))
      if (d === undefined) {
        d = await vtxoUnrollDepth(indexer, c)
        depth.set(key(c), d)
      }
      if (d > cap) deep.add(key(c))
    }
    if (deep.size === 0) return picked
    pool = pool.filter((c) => !deep.has(key(c)))
  }
}
