import type { Database } from 'bun:sqlite'
import type { ExtendedVirtualCoin } from '@arkade-os/sdk'
import { syncProofs, type ProofSyncIndexer, type ProofSyncResult } from './proof_sync'
import { vaultStats, type VaultStats } from './vault'

// Scheduling shell around syncProofs — #04 keeps the pass pure, this owns
// WHEN it runs:
//   - trigger(reason): debounced + single-flight. A burst of funds events
//     collapses into one pass; a trigger landing mid-pass queues exactly one
//     follow-up (the pass re-reads the full live set, so N queued triggers
//     and 1 are equivalent).
//   - escalating retry while the last pass reported gaps — right after a
//     settle the indexer may not serve the fresh PSBTs yet (EXIT_PLAN §7
//     #02: availability lag unmeasured, absorbed by generic backoff).
//   - slow reconcile poll as the safety net for events the subscription
//     missed (요구 7's "내가 트리거했든 아니든").
// Every pass ends by notifying listeners so the dashboard readiness
// fragment stays live over SSE.

export interface ProofSyncSnapshot {
  stats: VaultStats
  /**
   * What the ASP itself credited on the most recent pass whose listVtxos
   * succeeded — the "server says you own N" side of the dashboard's
   * claim-vs-proof comparison. Kept separately from lastRun because a
   * failed pass records total: 0, which is an outage, not a claim of zero.
   */
  claim: { total: number; at: number } | null
  lastRun: (ProofSyncResult & { at: number; reason: string }) | null
  running: boolean
}

export interface ProofSyncService {
  trigger(reason: string): void
  snapshot(): ProofSyncSnapshot
  onUpdate(cb: (snap: ProofSyncSnapshot) => void): () => void
  stop(): void
}

export interface ProofSyncTiming {
  debounceMs: number
  retryDelaysMs: readonly number[]
  pollIntervalMs: number
}

const DEFAULT_TIMING: ProofSyncTiming = {
  debounceMs: 1_500,
  retryDelaysMs: [5_000, 15_000, 60_000],
  pollIntervalMs: 10 * 60 * 1_000,
}

export function startProofSync(deps: {
  db: Database
  indexer: ProofSyncIndexer
  listVtxos: () => Promise<ExtendedVirtualCoin[]>
  /** our x-only pubkey — evidence-gated GC verifies spend signatures against it */
  xOnlyPubkey: Uint8Array
  timing?: Partial<ProofSyncTiming>
  log?: (msg: string) => void
}): ProofSyncService {
  const timing = { ...DEFAULT_TIMING, ...deps.timing }
  const log = deps.log ?? (() => {})
  const listeners = new Set<(snap: ProofSyncSnapshot) => void>()

  let running = false
  let stopped = false
  let pendingReason: string | null = null
  let retryCount = 0
  let lastRun: ProofSyncSnapshot['lastRun'] = null
  let claim: ProofSyncSnapshot['claim'] = null
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const snapshot = (): ProofSyncSnapshot => ({
    stats: vaultStats(deps.db),
    claim,
    lastRun,
    running,
  })

  const notify = (): void => {
    const snap = snapshot()
    for (const cb of listeners) cb(snap)
  }

  const run = async (reason: string): Promise<void> => {
    if (stopped) return
    if (running) {
      pendingReason = reason
      return
    }
    running = true
    notify() // dashboards show "syncing…" while a pass is in flight
    try {
      const vtxos = await deps.listVtxos()
      claim = { total: vtxos.length, at: Math.floor(Date.now() / 1000) }
      const result = await syncProofs(deps.db, deps.indexer, vtxos, deps.xOnlyPubkey)
      lastRun = { ...result, at: Math.floor(Date.now() / 1000), reason }
      if (result.gc.quarantined.length > 0) {
        log(
          `exit-sync: ⚠ ${result.gc.quarantined.length} vtxo(s) QUARANTINED — dropped by the ASP without evidence: ${result.gc.quarantined.join(', ')}`,
        )
      }
      if (result.gc.expired.length > 0) {
        log(
          `exit-sync: ${result.gc.expired.length} vtxo(s) expired unrefreshed and dropped by the ASP — kept for review (forget them on /exit): ${result.gc.expired.join(', ')}`,
        )
      }
      if (result.gc.released.length > 0) {
        log(`exit-sync: quarantine released (re-listed): ${result.gc.released.join(', ')}`)
      }
      if (result.failed.length > 0) {
        const delay = timing.retryDelaysMs[Math.min(retryCount, timing.retryDelaysMs.length - 1)]!
        retryCount++
        log(
          `exit-sync: ${result.failed.length} gap(s) (${reason}) — retrying in ${Math.round(delay / 1000)}s`,
        )
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => void run('retry'), delay)
      } else {
        retryCount = 0
        if (result.synced.length > 0) {
          log(`exit-sync: ${result.synced.length} vtxo(s) mirrored (${reason})`)
        }
      }
    } catch (err) {
      // listVtxos (wallet/indexer down mid-pass) or a bug — same treatment:
      // record, back off, let the poll/retry pick it back up.
      lastRun = {
        total: 0,
        synced: [],
        skipped: 0,
        failed: [{ outpoint: '*', error: err instanceof Error ? err.message : String(err) }],
        gc: { removedVtxos: 0, removedProofTxs: 0, quarantined: [], expired: [], released: [] },
        at: Math.floor(Date.now() / 1000),
        reason,
      }
      const delay = timing.retryDelaysMs[Math.min(retryCount, timing.retryDelaysMs.length - 1)]!
      retryCount++
      log(`exit-sync: pass failed (${reason}): ${lastRun.failed[0]!.error} — retrying in ${Math.round(delay / 1000)}s`)
      clearTimeout(retryTimer)
      retryTimer = setTimeout(() => void run('retry'), delay)
    } finally {
      running = false
      notify()
      if (pendingReason !== null && !stopped) {
        const next = pendingReason
        pendingReason = null
        void run(next)
      }
    }
  }

  const trigger = (reason: string): void => {
    if (stopped) return
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void run(reason), timing.debounceMs)
  }

  const poll = setInterval(() => trigger('poll'), timing.pollIntervalMs)

  return {
    trigger,
    snapshot,
    onUpdate(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    stop() {
      stopped = true
      clearInterval(poll)
      clearTimeout(debounceTimer)
      clearTimeout(retryTimer)
      listeners.clear()
    },
  }
}
