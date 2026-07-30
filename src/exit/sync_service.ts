import type { Database } from 'bun:sqlite'
import type { ExtendedVirtualCoin } from '@arkade-os/sdk'
import { syncProofs, type ProofSyncIndexer, type ProofSyncResult } from './proof_sync'
import { listMaturedBetrayals, vaultStats, type VaultStats } from './vault'
import { EXIT_QUARANTINE_DM_GRACE_MS, EXIT_SYNC_ALERT_THRESHOLD } from '../defaults'
import type { NotifyFn } from '../nostr/notifier'

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
  /**
   * Consecutive failed passes before the operator is alerted. With the
   * capped retry backoff this is roughly minutes of continuous ASP/indexer
   * unreachability — the bridge's de-facto ASP health probe.
   */
  alertThreshold: number
  /**
   * How long a betrayal quarantine must persist before its operator DM
   * fires — the grace that lets a transient post-settle quarantine self-heal
   * unannounced. See EXIT_QUARANTINE_DM_GRACE_MS.
   */
  quarantineDmGraceMs: number
}

const DEFAULT_TIMING: ProofSyncTiming = {
  debounceMs: 1_500,
  retryDelaysMs: [5_000, 15_000, 60_000],
  pollIntervalMs: 10 * 60 * 1_000,
  alertThreshold: EXIT_SYNC_ALERT_THRESHOLD,
  quarantineDmGraceMs: EXIT_QUARANTINE_DM_GRACE_MS,
}

// DM-sized outpoint list: a mass-sweep pass can quarantine dozens at once.
function listSome(items: readonly string[], max = 5): string {
  return items.length <= max
    ? items.join(', ')
    : `${items.slice(0, max).join(', ')} (+${items.length - max} more)`
}

export function startProofSync(deps: {
  db: Database
  indexer: ProofSyncIndexer
  listVtxos: () => Promise<ExtendedVirtualCoin[]>
  /** our x-only pubkey — evidence-gated GC verifies spend signatures against it */
  xOnlyPubkey: Uint8Array
  timing?: Partial<ProofSyncTiming>
  log?: (msg: string) => void
  /** Operator DM sink (named apart from the local snapshot notify()). */
  alert?: NotifyFn
  /** Unix-seconds clock for the betrayal-DM grace gate; injectable for tests. */
  now?: () => number
}): ProofSyncService {
  const timing = { ...DEFAULT_TIMING, ...deps.timing }
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const graceSec = Math.ceil(timing.quarantineDmGraceMs / 1000)
  // In-memory latch for the betrayal DM: which matured quarantines we've
  // already announced. Process-local on purpose — like aspAlerted, a restart
  // re-arms it, which only re-DMs genuine, still-unresolved betrayals (the
  // transient ones self-heal well before grace and never reach this set). The
  // persisted signal lives in quarantined_at; this just dedupes the alert.
  let notifiedBetrayals = new Set<string>()
  const listeners = new Set<(snap: ProofSyncSnapshot) => void>()
  // Edge latch: one DM when consecutive failures cross the threshold, one
  // when the next pass succeeds. Process-local on purpose — a restart
  // re-arming the alert is the right behavior, not a bug to persist away.
  let aspAlerted = false

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

  // Betrayal-DM gate. Runs after every pass (success or failure) because a
  // quarantine matures purely by the clock, so the poll is what re-checks it.
  // Fires one batched DM for the newly-matured, then re-syncs the latch to the
  // currently-matured set: self-healed/released rows drop out (re-arming the
  // latch if they ever re-quarantine), persistent ones stay (no re-DM). Own
  // try/catch — it must never break the run() finally / teardown.
  const checkMaturedBetrayals = (): void => {
    try {
      const matured = listMaturedBetrayals(deps.db, graceSec, now())
      const fresh = matured.filter((m) => !notifiedBetrayals.has(m.outpoint))
      if (fresh.length > 0) {
        log(`exit-sync: ⚠ ${fresh.length} betrayal quarantine(s) survived grace — alerting: ${fresh.map((m) => m.outpoint).join(', ')}`)
        deps.alert?.(
          'health-vault',
          () =>
            `health: ${fresh.length} vtxo(s) QUARANTINED (dropped by ASP without evidence): ${listSome(fresh.map((m) => m.outpoint))}`,
        )
      }
      notifiedBetrayals = new Set(matured.map((m) => m.outpoint))
    } catch (err) {
      log(`exit-sync: matured-betrayal check failed: ${err instanceof Error ? err.message : String(err)}`)
    }
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
      if (result.gc.absorbed.length > 0) {
        // routine on every refresh that folds sub-dust — log only, no DM
        log(
          `exit-sync: ${result.gc.absorbed.length} vtxo(s) absorbed by our own settlement (value conserved): ${result.gc.absorbed.join(', ')}`,
        )
      }
      if (result.gc.quarantined.length > 0) {
        // Log immediately for an operator tailing stdout, but do NOT DM here.
        // A post-settle indexer lag quarantines transiently and the next pass
        // self-heals it (removeVtxo on late evidence), so an immediate DM cries
        // wolf. The DM is gated on grace-survival — checkMaturedBetrayals below.
        log(
          `exit-sync: ⚠ ${result.gc.quarantined.length} vtxo(s) newly QUARANTINED (unproven drop, DM deferred past ${graceSec}s grace): ${result.gc.quarantined.join(', ')}`,
        )
      }
      if (result.gc.expired.length > 0) {
        log(
          `exit-sync: ${result.gc.expired.length} vtxo(s) expired unrefreshed and dropped by the ASP — kept for review (forget them on /exit): ${result.gc.expired.join(', ')}`,
        )
        deps.alert?.(
          'health-vault',
          () =>
            `health: ${result.gc.expired.length} vtxo(s) expired unrefreshed and dropped — review /exit: ${listSome(result.gc.expired)}`,
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
        if (!aspAlerted && retryCount >= timing.alertThreshold) {
          aspAlerted = true
          const failures = retryCount
          deps.alert?.(
            'health-asp',
            () => `health: proof sync degraded — ${result.failed.length} gap(s) for ${failures} passes`,
          )
        }
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => void run('retry'), delay)
      } else {
        retryCount = 0
        if (aspAlerted) {
          aspAlerted = false
          deps.alert?.('health-asp', () => 'health: proof sync recovered')
        }
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
        gc: { removedVtxos: 0, removedProofTxs: 0, absorbed: [], quarantined: [], expired: [], released: [] },
        at: Math.floor(Date.now() / 1000),
        reason,
      }
      const delay = timing.retryDelaysMs[Math.min(retryCount, timing.retryDelaysMs.length - 1)]!
      retryCount++
      log(`exit-sync: pass failed (${reason}): ${lastRun.failed[0]!.error} — retrying in ${Math.round(delay / 1000)}s`)
      if (!aspAlerted && retryCount >= timing.alertThreshold) {
        aspAlerted = true
        const failures = retryCount
        const lastError = lastRun.failed[0]!.error
        deps.alert?.(
          'health-asp',
          () => `health: proof sync failing — ${failures} consecutive failures (${lastError})`,
        )
      }
      clearTimeout(retryTimer)
      retryTimer = setTimeout(() => void run('retry'), delay)
    } finally {
      running = false
      if (!stopped) checkMaturedBetrayals()
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
