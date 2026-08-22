import type { Database } from 'bun:sqlite'
import { base64, hex } from '@scure/base'
import {
  Transaction,
  type ChainTx,
  type ExtendedVirtualCoin,
  type Outpoint,
  type VirtualCoin,
} from '@arkade-os/sdk'
import { classifyDisappearance, resolveAbsorbedByConservation } from './evidence'
import { danglingEntries } from './chain_order'
import { getExitOp } from './ops'
import {
  clearQuarantine,
  gcOrphanProofs,
  missingProofTxids,
  getVaultVtxo,
  listVaultVtxos,
  quarantineVtxo,
  removeVtxo,
  storeVtxoWithProofs,
  type VaultProofTx,
  type VaultVtxo,
  type VaultVtxoSnapshot,
} from './vault'

// ProofSync = the normal-mode half of unilateral exit (EXIT_PLAN §3): while
// the ASP is alive, mirror every live vtxo's pre-signed chain into the vault
// so the exit engine never needs the ASP again. One call = one full pass:
//   diff live vtxos against the vault → fetch chains (paged) for the rest →
//   fetch only the PSBTs the vault doesn't hold (paged, batched) → store
//   atomically per vtxo → evidence-gated GC over rows the live set dropped.
//
// GC never takes the server's word — and never deletes silently. A dropped
// row is deleted only on verifiable evidence (our own signature on the
// spending tx, or our own completed exit op); a locally-judged expiry is
// flagged for review instead (the lapse is the user's, but funds don't get
// to vanish without a word); anything else is quarantined with proofs
// intact, so the pre-signed exit chain survives exactly the scenario where
// the server starts lying. Quarantine self-heals in both directions: a
// re-listed vtxo is released, late evidence deletes.
//
// Deliberately single-pass with per-vtxo error isolation and NO internal
// retry/backoff — scheduling is the caller's job (#05 wires triggers +
// re-runs while `failed` is non-empty). A vtxo's ancestry is immutable once
// created, so a vault row that is proof-complete is skipped with zero
// network traffic; only its status/expiry snapshot is refreshed if drifted.

/** The three indexer reads ProofSync needs — structural subset of IndexerProvider, trivially fakeable. */
export interface ProofSyncIndexer {
  getVtxoChain(
    outpoint: Outpoint,
    opts?: { pageIndex?: number; pageSize?: number },
  ): Promise<{ chain: ChainTx[]; page?: { current: number; next: number; total: number } }>
  getVirtualTxs(
    txids: string[],
    opts?: { pageIndex?: number; pageSize?: number },
  ): Promise<{ txs: string[]; page?: { current: number; next: number; total: number } }>
  /** outpoint-keyed lookup — evidence.ts asks the server to explain a disappearance */
  getVtxos(opts: { outpoints: Outpoint[] }): Promise<{ vtxos: VirtualCoin[] }>
}

export interface ProofSyncResult {
  total: number
  /** outpoints fetched (or completed) this pass, now proof-complete */
  synced: string[]
  /** outpoints already proof-complete — zero network traffic */
  skipped: number
  /** per-vtxo isolation: one bad fetch never blocks the rest */
  failed: { outpoint: string; error: string }[]
  gc: {
    /** rows deleted WITH evidence (verified spend / our own completed exit / absorption) */
    removedVtxos: number
    removedProofTxs: number
    /**
     * rows deleted via value conservation: consumed without a forfeit by a
     * settlement whose outputs to us exactly account for them (the sub-dust
     * refresh case — no per-row signature can exist)
     */
    absorbed: string[]
    /** outpoints NEWLY flagged as unexplained — quarantined, proofs kept */
    quarantined: string[]
    /**
     * outpoints NEWLY flagged as expired-unrefreshed — the server dropped
     * them after their window lapsed. Kept (never silently deleted) for the
     * user to review and forget; nothing is exitable about them anymore.
     */
    expired: string[]
    /** previously quarantined outpoints released (re-listed by the server) */
    released: string[]
  }
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
export function expirySec(v: { virtualStatus?: unknown }): number | null {
  const raw = (v.virtualStatus as { batchExpiry?: number | bigint } | undefined)?.batchExpiry
  if (raw === undefined || raw === null) return null
  const n = Number(raw)
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function toSnapshot(v: ExtendedVirtualCoin, chain: ChainTx[]): VaultVtxoSnapshot {
  return {
    txid: v.txid,
    vout: v.vout,
    valueSat: v.value,
    source: 'wallet',
    script: v.script,
    tapTree: hex.encode(v.tapTree),
    status: v.virtualStatus?.state ?? 'unknown',
    expiresAt: expirySec(v),
    chain,
  }
}

/**
 * One-shot capture of a single vtxo the wallet does NOT own — an atomic
 * swap's shared vtxo lives at a custom script address, so the wallet-driven
 * passes above never see it (ATOMIC_SUBDUST_PLAN.md §8: today's gap is
 * invisibility, not quarantine). Same fetch/store machinery as a pass, no GC.
 * Best-effort by contract: the caller treats a throw/incomplete result as a
 * degraded safety mirror, never as a swap failure.
 */
export async function captureVtxo(
  db: Database,
  indexer: ProofSyncIndexer,
  vtxo: Omit<VaultVtxoSnapshot, 'chain'>,
): Promise<{ complete: boolean; unserved: string[]; dangling: string[] }> {
  const chain = await fetchChain(indexer, { txid: vtxo.txid, vout: vtxo.vout })
  if (chain.length === 0) throw new Error('indexer returned an empty chain')
  const missing = missingProofTxids(db, chain)
  const fetched = await fetchProofPsbts(indexer, missing)
  const typeOf = new Map(chain.map((c) => [c.txid, c.type]))
  const proofs: VaultProofTx[] = []
  const unserved: string[] = []
  for (const txid of missing) {
    const psbtB64 = fetched.get(txid)
    if (psbtB64) proofs.push({ txid, type: typeOf.get(txid)!, psbtB64 })
    else unserved.push(txid)
  }
  storeVtxoWithProofs(db, { ...vtxo, chain }, proofs)
  // A chain whose ancestry doesn't close is not a usable exit proof, however
  // many PSBTs came with it — say so rather than let the caller read
  // "complete" off the PSBT count alone (F22).
  const dangling = danglingEntries(chain).map((c: ChainTx) => c.txid)
  if (dangling.length > 0) {
    console.warn(
      `exit vault: captured chain for ${vtxo.txid}:${vtxo.vout} names ${dangling.length} ` +
        `ancestor(s) it does not contain — stored, but NOT exitable until a later pass repairs it`,
    )
  }
  return { complete: unserved.length === 0 && dangling.length === 0, unserved, dangling }
}

export async function syncProofs(
  db: Database,
  indexer: ProofSyncIndexer,
  vtxos: ExtendedVirtualCoin[],
  /** our x-only pubkey — the key evidence.ts verifies spend signatures against */
  xOnlyPubkey: Uint8Array,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<ProofSyncResult> {
  const result: ProofSyncResult = {
    total: vtxos.length,
    synced: [],
    skipped: 0,
    failed: [],
    gc: { removedVtxos: 0, removedProofTxs: 0, absorbed: [], quarantined: [], expired: [], released: [] },
  }

  for (const v of vtxos) {
    const key = outpointKey(v)
    try {
      const existing = getVaultVtxo(db, v.txid, v.vout)
      // "Ancestry is immutable" is true of the ancestry — NOT of our copy of
      // it. A chain captured with a hole (an older indexer's walk, a parent it
      // failed to resolve) used to be frozen forever: proof-completeness only
      // asks about txs the stored chain lists, so the hole made itself
      // invisible and the short-circuit below removed every chance to notice.
      // Two of three mainnet vtxos sat unexitable like that (F22). A broken
      // chain is therefore always re-fetched, and only a WHOLE one is reused.
      const storedIsWhole = existing != null && danglingEntries(existing.chain).length === 0
      if (existing && storedIsWhole && missingProofTxids(db, existing.chain).length === 0) {
        // Refresh the display snapshot only when it drifted (still no network).
        const snap = toSnapshot(v, existing.chain)
        if (snap.status !== existing.status || snap.expiresAt !== existing.expiresAt) {
          storeVtxoWithProofs(db, snap, [])
        }
        result.skipped++
        continue
      }
      if (existing && !storedIsWhole) {
        console.warn(
          `exit vault: ${key} has a broken ancestry (${danglingEntries(existing.chain).length} ` +
            `dangling entr(ies)) — re-fetching the chain`,
        )
      }

      const chain =
        existing?.chain?.length && storedIsWhole
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

  // ── evidence-gated GC ──
  const live = new Set(vtxos.map(outpointKey))
  // Pass 1: exonerate re-listed rows, honor our own exit ops, and collect
  // the disappearances that need third-party evidence.
  const needEvidence: VaultVtxo[] = []
  for (const row of listVaultVtxos(db)) {
    const key = outpointKey(row)
    if (live.has(key)) {
      // the server (re-)acknowledges it — a quarantined row is exonerated
      if (row.quarantinedAt !== null && clearQuarantine(db, row.txid, row.vout)) {
        result.gc.released.push(key)
      }
      continue
    }
    // Our own exit engine explains (or still needs) some disappearances
    // before the server is even asked. An unrolled vtxo leaves the live
    // list while the exit is still in flight (our own doing —
    // installUnrolledVtxoFilter in wallet.ts; arkd itself never
    // reclassifies an unrolled row) — sweep reads the vault row, so GC
    // must not touch it (under the old unconditional GC this could
    // strand a ready-mode exit). And a completed exit (state 'swept',
    // sweep broadcast by US) is its own evidence — without this check
    // every successful exit would end in a false betrayal alarm.
    const op = getExitOp(db, row.txid, row.vout)
    if (op && op.state !== 'failed') {
      if (op.state === 'swept') {
        if (removeVtxo(db, row.txid, row.vout)) result.gc.removedVtxos++
      }
      // unrolling / waiting / sweepable: exit in flight — keep silently
      continue
    }
    // Atomic-swap rows are lifecycle-owned: never in the wallet's live set
    // (script address), and their eventual spend is by the CLAIMER's key,
    // which the evidence machinery could never verify as ours — it would
    // false-flag them every pass. The swap code deletes them on terminal
    // states; a completed exit op is still honored above.
    if (row.source === 'atomic') continue
    needEvidence.push(row)
  }

  // Settlement absorption first (pass-level evidence): recoverable-class
  // round inputs are consumed WITHOUT a forfeit, so no signature exists for
  // classifyDisappearance to find — value conservation over the whole pass
  // is the only proof there can be. Runs before the per-row machinery so
  // the expired shortcut can't mislabel an absorbed row whose old batch
  // expiry has since lapsed. One batched read; on failure the rows simply
  // fall through to per-row classification and its retry semantics.
  let absorbed = new Set<string>()
  if (needEvidence.length > 0) {
    try {
      const res = await indexer.getVtxos({
        outpoints: needEvidence.map((r) => ({ txid: r.txid, vout: r.vout })),
      })
      const settledByOf = new Map(res.vtxos.map((v) => [outpointKey(v), v.settledBy]))
      absorbed = resolveAbsorbedByConservation(
        needEvidence.map((r) => ({
          outpoint: outpointKey(r),
          valueSat: r.valueSat,
          settledBy: settledByOf.get(outpointKey(r)),
        })),
        vtxos,
      )
    } catch {
      // indeterminate — same treatment classifyDisappearance failures get
    }
  }

  for (const row of needEvidence) {
    const key = outpointKey(row)
    if (absorbed.has(key)) {
      if (removeVtxo(db, row.txid, row.vout)) {
        result.gc.removedVtxos++
        result.gc.absorbed.push(key)
      }
      continue
    }
    try {
      const verdict = await classifyDisappearance(indexer, row, xOnlyPubkey, nowSec)
      if (verdict.kind === 'spent-verified') {
        // our own signature on the spend — evidence in hand, safe to forget
        if (removeVtxo(db, row.txid, row.vout)) result.gc.removedVtxos++
      } else if (verdict.kind === 'expired') {
        // The lapse is the user's, the drop is legitimate — but funds must
        // not vanish without a word. Flag it with the story; the user
        // reviews and forgets it from /exit (never auto-deleted).
        if (
          quarantineVtxo(
            db,
            row.txid,
            row.vout,
            'batch expired before a refresh and the server dropped it — nothing left to exit; review and forget',
          )
        ) {
          result.gc.expired.push(key)
        }
      } else {
        if (quarantineVtxo(db, row.txid, row.vout, verdict.reason)) {
          result.gc.quarantined.push(key)
        }
      }
    } catch (err) {
      // indeterminate (network mid-pass): keep the row un-flagged, let the
      // retry/poll re-ask — quarantining on our own connectivity would cry
      // wolf every outage
      result.failed.push({
        outpoint: key,
        error: `evidence check failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }
  result.gc.removedProofTxs = gcOrphanProofs(db)
  return result
}
