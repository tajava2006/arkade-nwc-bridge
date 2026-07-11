import type { Database } from 'bun:sqlite'
import { ChainTxType, type ChainTx } from '@arkade-os/sdk'

// Offline half of unilateral exit (EXIT_PLAN.md §3). While the ASP is alive,
// ProofSync mirrors every live vtxo's pre-signed tx chain into the two v10
// tables; when the ASP is gone the exit engine reads ONLY from here (plus
// esplora). Nothing in this module touches the network, the Wallet object,
// or the AppState — that independence is the whole point.
//
// Storage contract:
//   - exit_proof_txs rows are immutable and shared (txid PK dedupes DAG
//     branches across vtxos). storeVtxoWithProofs keeps the first copy.
//   - exit_vtxos rows are replaceable snapshots; a row may reference proofs
//     that haven't been fetched yet, so exit-readiness is always recomputed
//     against exit_proof_txs (missingProofTxids / isVtxoExitReady) rather
//     than trusted from the row's existence.
//   - rows are only DELETED with evidence in hand (evidence.ts): a verified
//     spend by our own key, a locally-judged expiry, or an operator forget.
//     A row the server drops without evidence is quarantined instead —
//     proofs retained, still exitable. The server's word alone must never
//     be able to destroy the escape hatch it exists to escape.

export interface VaultProofTx {
  txid: string
  type: ChainTxType
  psbtB64: string
}

export interface VaultVtxo {
  txid: string
  vout: number
  valueSat: number
  /** pkScript hex — lets tooling cross-check the row belongs to our wallet */
  script: string
  /** EncodedVtxoScript.tapTree hex — sweep re-derives exit paths + witnessUtxo from it without a Wallet */
  tapTree: string
  /** virtualStatus.state snapshot at sync time (display only) */
  status: string
  /** batch expiry, unix seconds — the exit deadline; null when the indexer gave none */
  expiresAt: number | null
  /** ChainTx[] exactly as the indexer returned it — Unroll.Session input */
  chain: ChainTx[]
  syncedAt: number
  /**
   * Set when the ASP dropped this vtxo from the live set WITHOUT verifiable
   * evidence (our signature on the spend, or a locally-judged expiry). The
   * row and its proofs are retained — still exitable — until evidence shows
   * up, the server re-lists it, or the operator forgets it. First-flagged
   * time; survives re-quarantine across passes.
   */
  quarantinedAt: number | null
  quarantineReason: string | null
}

export interface VaultStats {
  /** live rows (quarantined excluded — they're no longer server-claimed) */
  vtxoCount: number
  /** live vtxos whose every non-commitment chain tx has a stored proof */
  readyCount: number
  /**
   * flagged rows whose exit window is still open — the server dropped them
   * without evidence and exiting them IS the recourse; shown loudly
   */
  quarantinedCount: number
  /**
   * flagged rows whose batch expiry has passed — nothing left to exit
   * (regardless of why they were flagged: an unrefreshed lapse the server
   * dropped, or a betrayal quarantine that aged past its window). Kept for
   * the user to review and forget, never silently deleted.
   */
  expiredCount: number
  proofTxCount: number
  /** total stored PSBT size (base64 chars ≈ bytes on disk) */
  proofBytes: number
  lastSyncedAt: number | null
  soonestExpiresAt: number | null
}

interface VtxoRow {
  txid: string
  vout: number
  value_sat: number
  script: string
  tap_tree: string
  status: string
  expires_at: number | null
  chain_json: string
  synced_at: number
  quarantined_at: number | null
  quarantine_reason: string | null
}

// COMMITMENT txs are already onchain (that's what makes them commitments) so
// the indexer never serves PSBTs for them — they are chain metadata, not
// proofs. UNSPECIFIED is skipped the same way Unroll.Session skips it.
const NON_PROOF_TYPES: readonly string[] = [ChainTxType.COMMITMENT, ChainTxType.UNSPECIFIED]

/** Chain txids that require a stored proof (everything except commitment-level entries). */
export function proofTxidsOf(chain: ChainTx[]): string[] {
  return chain.filter((c) => !NON_PROOF_TYPES.includes(c.type)).map((c) => c.txid)
}

function rowToVtxo(r: VtxoRow): VaultVtxo {
  return {
    txid: r.txid,
    vout: r.vout,
    valueSat: r.value_sat,
    script: r.script,
    tapTree: r.tap_tree,
    status: r.status,
    expiresAt: r.expires_at,
    chain: JSON.parse(r.chain_json) as ChainTx[],
    syncedAt: r.synced_at,
    quarantinedAt: r.quarantined_at,
    quarantineReason: r.quarantine_reason,
  }
}

/** What ProofSync captures per pass — quarantine state is NOT part of it (GC owns that). */
export type VaultVtxoSnapshot = Omit<VaultVtxo, 'syncedAt' | 'quarantinedAt' | 'quarantineReason'>

/**
 * Atomically persist a vtxo snapshot together with (any of) its proofs.
 * Proofs may arrive across several calls; the vtxo row is fully replaced
 * each time (quarantine columns untouched), proof rows are insert-once.
 */
export function storeVtxoWithProofs(
  db: Database,
  vtxo: VaultVtxoSnapshot,
  proofs: VaultProofTx[],
): void {
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    const insertProof = db.query(
      `INSERT INTO exit_proof_txs (txid, type, psbt_base64, first_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(txid) DO NOTHING`,
    )
    for (const p of proofs) {
      insertProof.run(p.txid, p.type, p.psbtB64, now)
    }
    db.query(
      `INSERT INTO exit_vtxos (txid, vout, value_sat, script, tap_tree, status, expires_at, chain_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(txid, vout) DO UPDATE SET
         value_sat = excluded.value_sat,
         script = excluded.script,
         tap_tree = excluded.tap_tree,
         status = excluded.status,
         -- monotonic: an outpoint's batch never changes, so its expiry never
         -- legitimately shrinks. A server that "shortens" the expiry while a
         -- vtxo is live could otherwise fast-forward the evidence-gated GC's
         -- 'expired' verdict and get proofs deleted on its word after all.
         expires_at = CASE
           WHEN excluded.expires_at IS NULL THEN exit_vtxos.expires_at
           WHEN exit_vtxos.expires_at IS NULL THEN excluded.expires_at
           ELSE MAX(exit_vtxos.expires_at, excluded.expires_at)
         END,
         chain_json = excluded.chain_json,
         synced_at = excluded.synced_at`,
    ).run(
      vtxo.txid,
      vtxo.vout,
      vtxo.valueSat,
      vtxo.script,
      vtxo.tapTree,
      vtxo.status,
      vtxo.expiresAt,
      JSON.stringify(vtxo.chain),
      now,
    )
  })()
}

export function listVaultVtxos(db: Database): VaultVtxo[] {
  return db
    .query<VtxoRow, []>(`SELECT * FROM exit_vtxos ORDER BY expires_at ASC, txid, vout`)
    .all()
    .map(rowToVtxo)
}

export function getVaultVtxo(db: Database, txid: string, vout: number): VaultVtxo | null {
  const row = db
    .query<VtxoRow, [string, number]>(`SELECT * FROM exit_vtxos WHERE txid = ? AND vout = ?`)
    .get(txid, vout)
  return row ? rowToVtxo(row) : null
}

/**
 * Stored PSBTs for the given txids, keyed by txid. Missing entries are
 * simply absent — the caller decides whether that's fetch work (ProofSync)
 * or a hard error (the exit engine's stub indexer).
 */
export function getProofPsbts(db: Database, txids: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const q = db.query<{ psbt_base64: string }, [string]>(
    `SELECT psbt_base64 FROM exit_proof_txs WHERE txid = ?`,
  )
  for (const txid of txids) {
    const row = q.get(txid)
    if (row) out.set(txid, row.psbt_base64)
  }
  return out
}

/** Non-commitment chain txids that have no stored proof yet — ProofSync's fetch list. */
export function missingProofTxids(db: Database, chain: ChainTx[]): string[] {
  const wanted = proofTxidsOf(chain)
  const stored = getProofPsbts(db, wanted)
  return wanted.filter((txid) => !stored.has(txid))
}

/** True when every proof the vtxo's chain needs is stored — i.e. exitable offline right now. */
export function isVtxoExitReady(db: Database, txid: string, vout: number): boolean {
  const vtxo = getVaultVtxo(db, txid, vout)
  if (!vtxo) return false
  return missingProofTxids(db, vtxo.chain).length === 0
}

/**
 * Delete one vtxo row. Only call with evidence in hand (verified spend,
 * locally-judged expiry, or an explicit operator forget) — ProofSync's GC is
 * the sole automated caller and it gates on classifyDisappearance.
 */
export function removeVtxo(db: Database, txid: string, vout: number): boolean {
  const res = db.query(`DELETE FROM exit_vtxos WHERE txid = ? AND vout = ?`).run(txid, vout)
  return res.changes > 0
}

/**
 * Flag a row the server dropped without evidence (or that expired
 * unrefreshed — same mechanics, different story in the reason). Keeps the
 * FIRST quarantine time across repeated passes (the age is the signal —
 * "unexplained for 3 days" reads very differently from a 10-second-old
 * race); the reason is refreshed to the latest classification. Returns true
 * only when the row was newly flagged, so re-confirming passes don't re-log.
 */
export function quarantineVtxo(db: Database, txid: string, vout: number, reason: string): boolean {
  const wasFlagged =
    db
      .query<{ quarantined_at: number | null }, [string, number]>(
        `SELECT quarantined_at FROM exit_vtxos WHERE txid = ? AND vout = ?`,
      )
      .get(txid, vout)?.quarantined_at ?? null
  db.query(
    `UPDATE exit_vtxos
     SET quarantined_at = COALESCE(quarantined_at, ?), quarantine_reason = ?
     WHERE txid = ? AND vout = ?`,
  ).run(Math.floor(Date.now() / 1000), reason, txid, vout)
  return wasFlagged === null
}

/** Server re-listed the vtxo (or evidence resolved it) — lift the flag. */
export function clearQuarantine(db: Database, txid: string, vout: number): boolean {
  const res = db
    .query(
      `UPDATE exit_vtxos SET quarantined_at = NULL, quarantine_reason = NULL
       WHERE txid = ? AND vout = ? AND quarantined_at IS NOT NULL`,
    )
    .run(txid, vout)
  return res.changes > 0
}

/**
 * Drop proofs no remaining row's chain references — quarantined rows count
 * as references (their proofs ARE the retained exit capability). Reference
 * computation happens in code — solo-wallet scale (a few vtxos × ~100 txs)
 * doesn't justify a normalized ref table.
 */
export function gcOrphanProofs(db: Database): number {
  let removed = 0
  db.transaction(() => {
    const referenced = new Set<string>()
    for (const row of db.query<VtxoRow, []>(`SELECT * FROM exit_vtxos`).all()) {
      for (const txid of proofTxidsOf(JSON.parse(row.chain_json) as ChainTx[])) {
        referenced.add(txid)
      }
    }
    const deleteProof = db.query(`DELETE FROM exit_proof_txs WHERE txid = ?`)
    for (const { txid } of db.query<{ txid: string }, []>(`SELECT txid FROM exit_proof_txs`).all()) {
      if (!referenced.has(txid)) {
        deleteProof.run(txid)
        removed++
      }
    }
  })()
  return removed
}

export function vaultStats(db: Database, nowSec: number = Math.floor(Date.now() / 1000)): VaultStats {
  const all = listVaultVtxos(db)
  // Quarantined rows leave the readiness math (the server no longer claims
  // them, so counting them as "ready" would inflate proven vs claimed) but
  // keep their own loud counters — split on whether the exit window is
  // still open, because the user's next move differs completely ("exit it
  // NOW" vs "review and forget").
  const vtxos = all.filter((v) => v.quarantinedAt === null)
  const flagged = all.filter((v) => v.quarantinedAt !== null)
  const expiredCount = flagged.filter((v) => v.expiresAt !== null && v.expiresAt <= nowSec).length
  const readyCount = vtxos.filter((v) => missingProofTxids(db, v.chain).length === 0).length
  const proofs = db
    .query<{ count: number; bytes: number | null }, []>(
      `SELECT COUNT(*) AS count, SUM(LENGTH(psbt_base64)) AS bytes FROM exit_proof_txs`,
    )
    .get()
  const lastSyncedAt = vtxos.reduce<number | null>(
    (acc, v) => (acc === null || v.syncedAt > acc ? v.syncedAt : acc),
    null,
  )
  const soonestExpiresAt = all.reduce<number | null>(
    (acc, v) =>
      v.expiresAt !== null && (acc === null || v.expiresAt < acc) ? v.expiresAt : acc,
    null,
  )
  return {
    vtxoCount: vtxos.length,
    readyCount,
    quarantinedCount: flagged.length - expiredCount,
    expiredCount,
    proofTxCount: proofs?.count ?? 0,
    proofBytes: proofs?.bytes ?? 0,
    lastSyncedAt,
    soonestExpiresAt,
  }
}
