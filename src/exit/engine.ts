import type { Database } from 'bun:sqlite'
import {
  EsploraProvider,
  OnchainWallet,
  Unroll,
  type AnchorBumper,
  type Identity,
  type OnchainProvider,
} from '@arkade-os/sdk'
import type { Network } from '../defaults'
import { pickEsplora } from './esplora'
import { getVaultVtxo } from './vault'
import { VaultIndexer } from './vault_indexer'
import { availableExitPath } from './csv'
import {
  createOrRestartExitOp,
  getExitOp,
  listExitOps,
  setExitOpState,
  type ExitOp,
} from './ops'

// The emergency half of unilateral exit (EXIT_PLAN #09): drives the SDK's
// Unroll.Session over the local vault (VaultIndexer) with CPFP fees paid by
// the nsec-derived OnchainWallet — nothing here touches the ASP, so the
// engine runs identically in ready and degraded mode.
//
// Progress model: exit_ops rows are coarse intent records; the actual unroll
// position is re-derived from chain state on every run (Session skips
// everything already onchain), so resume() after a crash/restart simply
// re-runs the session. Ops run strictly one at a time — vtxos that share
// history branches then dedupe naturally (the second session sees the shared
// txs onchain/in-mempool and skips/waits), and the CPFP wallet never races
// itself for UTXOs. Execution is per-vtxo BY DESIGN (§1: no bulk exit).

export interface ExitEngineUpdate {
  txid: string
  vout: number
  op: ExitOp | null
  /** last observed session step, when the op is actively unrolling */
  step?: { type: 'UNROLL' | 'WAIT' | 'DONE'; txid?: string }
}

export interface ExitEngine {
  /** Enqueue a vtxo for unilateral exit; restarts a failed op. No-op while queued/active. */
  startExit(txid: string, vout: number): void
  /** Re-enqueue non-terminal ops after a restart. */
  resume(): void
  snapshot(): { ops: ExitOp[]; active: string | null }
  onUpdate(cb: (u: ExitEngineUpdate) => void): () => void
  stop(): void
}

export interface ExitEngineDeps {
  db: Database
  identity: Identity
  network: Network
  esploraUrls: readonly string[]
  /** test seam / future override — production resolves via pickEsplora + OnchainWallet */
  providers?: { bumper: AnchorBumper; explorer: OnchainProvider }
  /** waiting→sweepable re-check cadence; CSV clocks tick in blocks, so minutes are plenty */
  pollIntervalMs?: number
  log?: (msg: string) => void
}

const DEFAULT_POLL_MS = 60_000

export function startExitEngine(deps: ExitEngineDeps): ExitEngine {
  const { db } = deps
  const log = deps.log ?? (() => {})
  const listeners = new Set<(u: ExitEngineUpdate) => void>()
  const indexer = new VaultIndexer(db)

  let stopped = false
  let active: string | null = null
  const queue: { txid: string; vout: number }[] = []

  // Resolved once, lazily: pickEsplora probes the priority list and the
  // OnchainWallet derives the CPFP wallet from the nsec — neither involves
  // the ASP. Cached so every op shares one provider pair.
  let providersPromise: Promise<{ bumper: AnchorBumper; explorer: OnchainProvider }> | null =
    deps.providers ? Promise.resolve(deps.providers) : null
  const providers = (): Promise<{ bumper: AnchorBumper; explorer: OnchainProvider }> => {
    if (!providersPromise) {
      providersPromise = (async () => {
        const picked = await pickEsplora(deps.esploraUrls)
        if (!picked.healthy) {
          log(`exit-engine: no esplora candidate answered — proceeding with ${picked.url}`)
        }
        const bumper = await OnchainWallet.create(
          deps.identity,
          deps.network,
          new EsploraProvider(picked.url),
        )
        return { bumper, explorer: picked.provider }
      })()
    }
    return providersPromise
  }

  const notify = (txid: string, vout: number, step?: ExitEngineUpdate['step']): void => {
    const u: ExitEngineUpdate = { txid, vout, op: getExitOp(db, txid, vout), step }
    for (const cb of listeners) cb(u)
  }

  const checkWaiting = async (op: ExitOp): Promise<void> => {
    const vtxo = getVaultVtxo(db, op.txid, op.vout)
    if (!vtxo) return
    const { explorer } = await providers()
    const status = await explorer.getTxStatus(op.txid)
    if (!status.confirmed) return
    const tip = await explorer.getChainTip()
    const confirmedAt = { height: status.blockHeight, time: status.blockTime }
    if (availableExitPath(vtxo.tapTree, confirmedAt, tip)) {
      setExitOpState(db, op.txid, op.vout, 'sweepable')
      log(`exit-engine: ${op.txid}:${op.vout} CSV elapsed — sweepable`)
      notify(op.txid, op.vout)
    }
  }

  const runOp = async (txid: string, vout: number): Promise<void> => {
    const key = `${txid}:${vout}`
    active = key
    try {
      const vtxo = getVaultVtxo(db, txid, vout)
      if (!vtxo) {
        throw new Error('exit vault has no chain for this vtxo — it was never mirrored')
      }
      const { bumper, explorer } = await providers()
      const session = new Unroll.Session({ txid, vout, chain: vtxo.chain }, bumper, explorer, indexer)

      log(`exit-engine: unrolling ${key} (${vtxo.chain.length} chain entries)`)
      for await (const step of session) {
        if (step.type === Unroll.StepType.UNROLL) {
          log(`exit-engine: ${key} broadcast ${step.tx.id}`)
          notify(txid, vout, { type: 'UNROLL', txid: step.tx.id })
        } else if (step.type === Unroll.StepType.WAIT) {
          log(`exit-engine: ${key} waiting for ${step.txid} to confirm`)
          notify(txid, vout, { type: 'WAIT', txid: step.txid })
        }
        setExitOpState(db, txid, vout, 'unrolling')
        if (stopped) return // soft-stop between steps; resume() re-derives on next boot
      }

      // Session DONE = every chain tx is confirmed onchain. The CSV clock is
      // now running against the vtxo tx's confirmation height/time.
      setExitOpState(db, txid, vout, 'waiting')
      log(`exit-engine: ${key} fully unrolled — CSV wait`)
      notify(txid, vout, { type: 'DONE' })
      await checkWaiting(getExitOp(db, txid, vout)!)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setExitOpState(db, txid, vout, 'failed', { error: msg })
      log(`exit-engine: ${key} failed — ${msg}`)
      notify(txid, vout)
    } finally {
      active = null
    }
  }

  let running = false
  const drain = (): void => {
    if (running || stopped) return
    running = true
    void (async () => {
      try {
        for (;;) {
          const next = queue.shift()
          if (!next || stopped) break
          await runOp(next.txid, next.vout)
        }
      } finally {
        running = false
      }
    })()
  }

  const enqueue = (txid: string, vout: number): void => {
    const key = `${txid}:${vout}`
    if (active === key || queue.some((q) => q.txid === txid && q.vout === vout)) return
    queue.push({ txid, vout })
    drain()
  }

  const poll = setInterval(() => {
    if (stopped) return
    for (const op of listExitOps(db, ['waiting'])) {
      void checkWaiting(op).catch((err) =>
        log(
          `exit-engine: CSV check failed for ${op.txid}:${op.vout}: ${err instanceof Error ? err.message : err}`,
        ),
      )
    }
  }, deps.pollIntervalMs ?? DEFAULT_POLL_MS)

  return {
    startExit(txid, vout) {
      createOrRestartExitOp(db, txid, vout)
      notify(txid, vout)
      enqueue(txid, vout)
    },
    resume() {
      const pending = listExitOps(db, ['unrolling'])
      for (const op of pending) enqueue(op.txid, op.vout)
      if (pending.length > 0) {
        log(`exit-engine: resumed ${pending.length} in-flight exit(s)`)
      }
      // waiting/sweepable ops need no session — the poll picks them up; run
      // one immediate pass so a restart doesn't wait a full interval
      for (const op of listExitOps(db, ['waiting'])) {
        void checkWaiting(op).catch(() => {})
      }
    },
    snapshot() {
      return { ops: listExitOps(db), active }
    },
    onUpdate(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    stop() {
      stopped = true
      clearInterval(poll)
      listeners.clear()
    },
  }
}
