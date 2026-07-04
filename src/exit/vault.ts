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
}

export interface VaultStats {
  vtxoCount: number
  /** vtxos whose every non-commitment chain tx has a stored proof */
  readyCount: number
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
  }
}

/**
 * Atomically persist a vtxo snapshot together with (any of) its proofs.
 * Proofs may arrive across several calls; the vtxo row is fully replaced
 * each time, proof rows are insert-once.
 */
export function storeVtxoWithProofs(
  db: Database,
  vtxo: Omit<VaultVtxo, 'syncedAt'>,
  proofs: VaultProofTx[],
): VaultVtxo {
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
         expires_at = excluded.expires_at,
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
  return { ...vtxo, syncedAt: now }
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
 * Drop vtxo rows that are no longer live (spent / swept / refreshed away),
 * then drop proofs no remaining chain references. Reference computation
 * happens in code — solo-wallet scale (a few vtxos × ~100 txs) doesn't
 * justify a normalized ref table.
 */
export function gcVault(
  db: Database,
  liveOutpoints: { txid: string; vout: number }[],
): { removedVtxos: number; removedProofTxs: number } {
  const live = new Set(liveOutpoints.map((o) => `${o.txid}:${o.vout}`))
  let removedVtxos = 0
  let removedProofTxs = 0
  db.transaction(() => {
    const stored = db.query<VtxoRow, []>(`SELECT * FROM exit_vtxos`).all()
    const deleteVtxo = db.query(`DELETE FROM exit_vtxos WHERE txid = ? AND vout = ?`)
    const referenced = new Set<string>()
    for (const row of stored) {
      if (live.has(`${row.txid}:${row.vout}`)) {
        for (const txid of proofTxidsOf(JSON.parse(row.chain_json) as ChainTx[])) {
          referenced.add(txid)
        }
      } else {
        deleteVtxo.run(row.txid, row.vout)
        removedVtxos++
      }
    }
    const deleteProof = db.query(`DELETE FROM exit_proof_txs WHERE txid = ?`)
    const proofTxids = db.query<{ txid: string }, []>(`SELECT txid FROM exit_proof_txs`).all()
    for (const { txid } of proofTxids) {
      if (!referenced.has(txid)) {
        deleteProof.run(txid)
        removedProofTxs++
      }
    }
  })()
  return { removedVtxos, removedProofTxs }
}

export function vaultStats(db: Database): VaultStats {
  const vtxos = listVaultVtxos(db)
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
  const soonestExpiresAt = vtxos.reduce<number | null>(
    (acc, v) =>
      v.expiresAt !== null && (acc === null || v.expiresAt < acc) ? v.expiresAt : acc,
    null,
  )
  return {
    vtxoCount: vtxos.length,
    readyCount,
    proofTxCount: proofs?.count ?? 0,
    proofBytes: proofs?.bytes ?? 0,
    lastSyncedAt,
    soonestExpiresAt,
  }
}
