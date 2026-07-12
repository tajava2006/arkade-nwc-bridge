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
import { sweepVtxos, type SweepResult } from './sweep'
import { recordBroadcast } from './broadcasts'
import { listVaultVtxos } from './vault'
import {
  clearExitDest,
  getExitDest,
  issueDestChallenge,
  submitDestSignature,
  type ExitDest,
  type IssueResult,
  type SubmitResult,
} from './dest'
import {
  boostFinalSend,
  finalSend,
  finalSendInfo,
  type FinalSendInfo,
  type FinalSendResult,
} from './final_send'
import {
  boostStep,
  boostSweep,
  esploraReader,
  stepBoostInfo,
  sweepBoostInfo,
  type BoostDeps,
  type BoostStepResult,
  type FuelSource,
  type StepBoostInfo,
  type SweepBoostInfo,
  type EsploraReader,
} from './boost'

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
  /**
   * Spend sweepable vtxos through their CSV exit path in ONE tx (fee
   * sharing — the exit decision was already made per-vtxo, EXIT_PLAN §1).
   * destAddress defaults to the nsec-derived P2TR.
   */
  sweep(outpoints: { txid: string; vout: number }[], destAddress?: string): Promise<SweepResult>
  /** Re-enqueue non-terminal ops after a restart. */
  resume(): void
  /** current fee rate from the exit esplora (floor 1); 1 when unreachable — estimates stay renderable offline */
  feeRate(): Promise<number>
  /** the resolved exit esplora — for the stepper's per-tx onchain status reads */
  explorer(): Promise<OnchainProvider>
  /** fee context of one in-mempool unroll package; null when it can't be priced */
  stepBoostInfo(txid: string, vout: number, stepTxid: string): Promise<StepBoostInfo | null>
  /** replace the package's CPFP child with a higher-fee one (RBF) and resubmit */
  boostStep(txid: string, vout: number, stepTxid: string): Promise<BoostStepResult>
  /** fee context of the sweep tx once the op is 'swept'; null when unpriceable */
  sweepBoostInfo(txid: string, vout: number): Promise<SweepBoostInfo | null>
  /** RBF the (possibly batched) sweep tx at the current rate */
  boostSweep(txid: string, vout: number): Promise<SweepResult>
  /** CPFP fuel + sweep-destination status: the nsec P2TR address and its onchain balance (null when esplora is unreachable) */
  fundingStatus(): Promise<{ address: string; balanceSat: number | null }>
  /** the challenge-verified final-send destination row, if any */
  destStatus(): ExitDest | null
  /** validate the address and (re-)issue a signing challenge; replaces any previous dest */
  issueDest(address: string): IssueResult
  /** verify the challenge signature; on success the dest becomes final-send-able */
  verifyDest(signatureB64: string): SubmitResult
  /** drop the destination row (challenge and verification both) */
  clearDest(): void
  /** vault-vs-swept tally for the "are the unswept ones really abandoned?" confirmation */
  exitSummary(): { total: number; swept: number; unresolved: number }
  /** send EVERYTHING on the fuel address to the verified destination (exact-fee, no change) */
  finalSend(): Promise<FinalSendResult>
  /** fee context of the last final send; null when there is none or it can't be priced */
  finalSendInfo(): Promise<FinalSendInfo | null>
  /** RBF the last final send at the current rate */
  boostFinalSend(): Promise<FinalSendResult>
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
  providers?: {
    bumper: AnchorBumper
    explorer: OnchainProvider
    /** boost-path extras; production derives both (fuel = the OnchainWallet bumper, reader = raw esplora reads) */
    fuel?: FuelSource
    reader?: EsploraReader
  }
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
  // the ASP. Cached so every op shares one provider set.
  interface Providers {
    bumper: AnchorBumper
    explorer: OnchainProvider
    fuel: FuelSource | null
    reader: EsploraReader | null
  }
  let providersPromise: Promise<Providers> | null = deps.providers
    ? Promise.resolve({
        bumper: deps.providers.bumper,
        explorer: deps.providers.explorer,
        fuel: deps.providers.fuel ?? null,
        reader: deps.providers.reader ?? null,
      })
    : null
  const providers = (): Promise<Providers> => {
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
        // the CPFP wallet doubles as the boost path's fuel source; per-tx fee
        // reads go straight to the picked esplora (no SDK method for them)
        return {
          bumper,
          explorer: picked.provider,
          fuel: bumper,
          reader: esploraReader(picked.url),
        }
      })()
    }
    return providersPromise
  }

  const boostDeps = async (): Promise<BoostDeps> => {
    const p = await providers()
    if (!p.fuel || !p.reader) {
      throw new Error('boost unavailable — no fuel wallet / tx info source configured')
    }
    return {
      db,
      identity: deps.identity,
      network: deps.network,
      explorer: p.explorer,
      fuel: p.fuel,
      reader: p.reader,
    }
  }

  const tipHeightSafe = async (explorer: OnchainProvider): Promise<number | null> => {
    try {
      return (await explorer.getChainTip()).height
    } catch {
      return null
    }
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
      // Session gets the chain EXACTLY as the indexer returned it. arkd's
      // BFS array is a valid broadcast order when scanned back-to-front
      // (chain_order.ts spells out why) and it's the shape the SDK is tested
      // against — re-deriving the order here would only add a failure mode.
      const session = new Unroll.Session({ txid, vout, chain: vtxo.chain }, bumper, explorer, indexer)

      log(`exit-engine: unrolling ${key} (${vtxo.chain.length} chain entries)`)
      for await (const step of session) {
        if (step.type === Unroll.StepType.UNROLL) {
          log(`exit-engine: ${key} broadcast ${step.tx.id}`)
          // the "waiting N blocks" anchor for the boost UI; best-effort — a
          // failed tip read only hides the counter
          recordBroadcast(db, step.tx.id, txid, vout, await tipHeightSafe(explorer))
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

  // The nsec-derived onchain wallet: CPFP fuel source, default sweep
  // destination, funding-panel balance. Built from the key + first esplora
  // (address needs no network; getBalance does), cached and shared.
  let fundingWalletPromise: Promise<OnchainWallet> | null = null
  const fundingWallet = (): Promise<OnchainWallet> => {
    if (!fundingWalletPromise) {
      fundingWalletPromise = OnchainWallet.create(
        deps.identity,
        deps.network,
        new EsploraProvider(deps.esploraUrls[0]),
      )
    }
    return fundingWalletPromise
  }

  return {
    startExit(txid, vout) {
      createOrRestartExitOp(db, txid, vout)
      notify(txid, vout)
      enqueue(txid, vout)
    },
    async sweep(outpoints, destAddress) {
      for (const o of outpoints) {
        const op = getExitOp(db, o.txid, o.vout)
        if (op?.state !== 'sweepable') {
          throw new Error(
            `${o.txid}:${o.vout} is not sweepable (state: ${op?.state ?? 'no exit op'})`,
          )
        }
      }
      const { explorer } = await providers()
      const dest = destAddress ?? (await fundingWallet()).address
      const result = await sweepVtxos(
        { db, identity: deps.identity, explorer, network: deps.network },
        outpoints,
        dest,
      )
      recordBroadcast(
        db,
        result.txid,
        outpoints[0]!.txid,
        outpoints[0]!.vout,
        await tipHeightSafe(explorer),
      )
      for (const o of outpoints) {
        setExitOpState(db, o.txid, o.vout, 'swept', { sweepTxid: result.txid, destAddress: dest })
        notify(o.txid, o.vout)
      }
      log(
        `exit-engine: swept ${result.inputCount} vtxo(s) → ${dest} (${result.amountSat} sats, fee ${result.feeSat}) in ${result.txid}`,
      )
      return result
    },
    async explorer() {
      return (await providers()).explorer
    },
    async stepBoostInfo(txid, vout, stepTxid) {
      return stepBoostInfo(await boostDeps(), txid, vout, stepTxid)
    },
    async boostStep(txid, vout, stepTxid) {
      const result = await boostStep(await boostDeps(), txid, vout, stepTxid)
      log(
        `exit-engine: boosted ${stepTxid} — new child ${result.childTxid} at ${result.pkgRateSatVb} sat/vB (${result.feeSat} sats)`,
      )
      notify(txid, vout)
      return result
    },
    async sweepBoostInfo(txid, vout) {
      return sweepBoostInfo(await boostDeps(), txid, vout)
    },
    async boostSweep(txid, vout) {
      const result = await boostSweep(await boostDeps(), txid, vout)
      log(
        `exit-engine: boosted sweep — ${result.txid} pays ${result.feeSat} sats over ${result.inputCount} input(s)`,
      )
      notify(txid, vout)
      return result
    },
    async fundingStatus() {
      const w = await fundingWallet()
      let balanceSat: number | null = null
      try {
        balanceSat = await w.getBalance()
      } catch {
        // esplora unreachable — show the address, leave balance unknown
      }
      return { address: w.address, balanceSat }
    },
    destStatus() {
      return getExitDest(db)
    },
    issueDest(address) {
      const result = issueDestChallenge(db, deps.network, address)
      if (result.ok) log(`exit-engine: issued final-send challenge for ${result.dest.address}`)
      return result
    },
    verifyDest(signatureB64) {
      const result = submitDestSignature(db, deps.network, signatureB64)
      if (result.ok) {
        log(
          `exit-engine: final-send destination ${result.dest.address} verified (${result.dest.scheme})`,
        )
      }
      return result
    },
    clearDest() {
      clearExitDest(db)
    },
    exitSummary() {
      // total counts everything ever known: vault rows still present plus
      // swept ops whose vault row the evidence-gated GC already reclaimed
      const swept = new Set(listExitOps(db, ['swept']).map((o) => `${o.txid}:${o.vout}`))
      const unresolved = listVaultVtxos(db).filter(
        (v) => !swept.has(`${v.txid}:${v.vout}`),
      ).length
      return { total: unresolved + swept.size, swept: swept.size, unresolved }
    },
    async finalSend() {
      const result = await finalSend(await boostDeps())
      log(
        `exit-engine: final send → ${getExitDest(db)?.address} (${result.amountSat} sats over ${result.inputCount} input(s), fee ${result.feeSat}) in ${result.txid}`,
      )
      return result
    },
    async finalSendInfo() {
      return finalSendInfo(await boostDeps())
    },
    async boostFinalSend() {
      const result = await boostFinalSend(await boostDeps())
      log(
        `exit-engine: boosted final send — ${result.txid} pays ${result.feeSat} sats over ${result.inputCount} input(s)`,
      )
      return result
    },
    async feeRate() {
      try {
        const { explorer } = await providers()
        const rate = await explorer.getFeeRate()
        return Math.max(1, Math.ceil(rate ?? 1))
      } catch {
        return 1
      }
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
