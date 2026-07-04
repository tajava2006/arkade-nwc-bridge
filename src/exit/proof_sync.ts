import type { Database } from 'bun:sqlite'
import { base64, hex } from '@scure/base'
import { Transaction, type ChainTx, type ExtendedVirtualCoin, type Outpoint } from '@arkade-os/sdk'
import {
  gcVault,
  missingProofTxids,
  getVaultVtxo,
  storeVtxoWithProofs,
  type VaultProofTx,
  type VaultVtxo,
} from './vault'

// ProofSync = the normal-mode half of unilateral exit (EXIT_PLAN §3): while
// the ASP is alive, mirror every live vtxo's pre-signed chain into the vault
// so the exit engine never needs the ASP again. One call = one full pass:
//   diff live vtxos against the vault → fetch chains (paged) for the rest →
//   fetch only the PSBTs the vault doesn't hold (paged, batched) → store
//   atomically per vtxo → GC rows the live set no longer references.
//
// Deliberately single-pass with per-vtxo error isolation and NO internal
// retry/backoff — scheduling is the caller's job (#05 wires triggers +
// re-runs while `failed` is non-empty). A vtxo's ancestry is immutable once
// created, so a vault row that is proof-complete is skipped with zero
// network traffic; only its status/expiry snapshot is refreshed if drifted.

/** The two indexer reads ProofSync needs — structural subset of IndexerProvider, trivially fakeable. */
export interface ProofSyncIndexer {
  getVtxoChain(
    outpoint: Outpoint,
    opts?: { pageIndex?: number; pageSize?: number },
  ): Promise<{ chain: ChainTx[]; page?: { current: number; next: number; total: number } }>
  getVirtualTxs(
    txids: string[],
    opts?: { pageIndex?: number; pageSize?: number },
  ): Promise<{ txs: string[]; page?: { current: number; next: number; total: number } }>
}

export interface ProofSyncResult {
  total: number
  /** outpoints fetched (or completed) this pass, now proof-complete */
  synced: string[]
  /** outpoints already proof-complete — zero network traffic */
  skipped: number
  /** per-vtxo isolation: one bad fetch never blocks the rest */
  failed: { outpoint: string; error: string }[]
  gc: { removedVtxos: number; removedProofTxs: number }
}

// PageResponse's last-page sentinel is undocumented; "next doesn't advance"
// or a missing page object means done, and the cap keeps a surprising
// sentinel from looping forever (measured mainnet chain: ~119 entries, so
// 50 pages × 100 is an order of magnitude of headroom).
const MAX_PAGES = 50
const PAGE_SIZE = 100

async function fetchChain(indexer: ProofSyncIndexer, outpoint: Outpoint): Promise<ChainTx[]> {
  const chain: ChainTx[] = []
  let pageIndex = 0
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await indexer.getVtxoChain(outpoint, { pageIndex, pageSize: PAGE_SIZE })
    chain.push(...res.chain)
    if (!res.page || res.page.next <= res.page.current) break
    pageIndex = res.page.next
  }
  return chain
}

/**
 * Fetch PSBTs and key them by their *decoded* txid — never by request order.
 * A proof filed under the wrong txid would surface as a broken exit at the
 * worst possible moment, so the label must come from the payload itself.
 */
async function fetchProofPsbts(
  indexer: ProofSyncIndexer,
  txids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (txids.length === 0) return out
  let pageIndex = 0
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await indexer.getVirtualTxs(txids, { pageIndex, pageSize: PAGE_SIZE })
    for (const psbtB64 of res.txs) {
      const tx = Transaction.fromPSBT(base64.decode(psbtB64))
      out.set(tx.id, psbtB64)
    }
    if (!res.page || res.page.next <= res.page.current) break
    pageIndex = res.page.next
  }
  return out
}

function outpointKey(v: { txid: string; vout: number }): string {
  return `${v.txid}:${v.vout}`
}

/** virtualStatus.batchExpiry comes in ms from the SDK; the vault stores unix seconds. */
function expirySec(v: ExtendedVirtualCoin): number | null {
  const raw = (v.virtualStatus as { batchExpiry?: number | bigint } | undefined)?.batchExpiry
  if (raw === undefined || raw === null) return null
  const n = Number(raw)
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function toSnapshot(v: ExtendedVirtualCoin, chain: ChainTx[]): Omit<VaultVtxo, 'syncedAt'> {
  return {
    txid: v.txid,
    vout: v.vout,
    valueSat: v.value,
    script: v.script,
    tapTree: hex.encode(v.tapTree),
    status: v.virtualStatus?.state ?? 'unknown',
    expiresAt: expirySec(v),
    chain,
  }
}

export async function syncProofs(
  db: Database,
  indexer: ProofSyncIndexer,
  vtxos: ExtendedVirtualCoin[],
): Promise<ProofSyncResult> {
  const result: ProofSyncResult = {
    total: vtxos.length,
    synced: [],
    skipped: 0,
    failed: [],
    gc: { removedVtxos: 0, removedProofTxs: 0 },
  }

  for (const v of vtxos) {
    const key = outpointKey(v)
    try {
      const existing = getVaultVtxo(db, v.txid, v.vout)
      if (existing && missingProofTxids(db, existing.chain).length === 0) {
        // Ancestry is immutable → proof-complete means nothing to fetch.
        // Refresh the display snapshot only when it drifted (still no network).
        const snap = toSnapshot(v, existing.chain)
        if (snap.status !== existing.status || snap.expiresAt !== existing.expiresAt) {
          storeVtxoWithProofs(db, snap, [])
        }
        result.skipped++
        continue
      }

      const chain = existing?.chain?.length
        ? existing.chain
        : await fetchChain(indexer, { txid: v.txid, vout: v.vout })
      if (chain.length === 0) {
        // an indexer hiccup must not masquerade as a proof-complete vtxo
        result.failed.push({ outpoint: key, error: 'indexer returned an empty chain' })
        continue
      }
      const missing = missingProofTxids(db, chain)
      const fetched = await fetchProofPsbts(indexer, missing)

      const typeOf = new Map(chain.map((c) => [c.txid, c.type]))
      const proofs: VaultProofTx[] = []
      const unserved: string[] = []
      for (const txid of missing) {
        const psbtB64 = fetched.get(txid)
        if (psbtB64) {
          proofs.push({ txid, type: typeOf.get(txid)!, psbtB64 })
        } else {
          unserved.push(txid)
        }
      }

      // Store whatever arrived even on partial failure — readiness is
      // recomputed from proofs, and the next pass only refetches the gap.
      storeVtxoWithProofs(db, toSnapshot(v, chain), proofs)

      if (unserved.length > 0) {
        result.failed.push({
          outpoint: key,
          error: `indexer did not serve ${unserved.length} proof tx(s): ${unserved.join(', ')}`,
        })
      } else {
        result.synced.push(key)
      }
    } catch (err) {
      result.failed.push({ outpoint: key, error: err instanceof Error ? err.message : String(err) })
    }
  }

  result.gc = gcVault(
    db,
    vtxos.map((v) => ({ txid: v.txid, vout: v.vout })),
  )
  return result
}
