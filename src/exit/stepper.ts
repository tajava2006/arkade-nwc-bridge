import type { Database } from 'bun:sqlite'
import { ChainTxType, type OnchainProvider } from '@arkade-os/sdk'
import { getVaultVtxo, proofTxidsOf, type VaultVtxo } from './vault'
import { getExitOp, type ExitOp } from './ops'
import { estimateExit, storedTxVsize } from './estimate'
import { csvPathStatuses } from './csv'

// The visual model behind requirement 10: a vertical stepper that answers
// "how many broadcasts, where am I, how much longer". Broadcast steps run
// root→leaf (commitment, always onchain → … → the vtxo tx), each tagged with
// its measured vsize (same numbers the #11 estimate sums).
//
// The initial build is DB-only — a mainnet chain is 100+ entries, and one
// serial esplora read per entry used to hold the response past Bun.serve's
// idleTimeout, killing the socket before any HTML went out. Onchain statuses
// arrive after render instead: the page probes steps one at a time
// (probeExitStep, root→leaf) and stops at the first non-confirmed tx. The
// early stop is sound because Unroll.Session broadcasts strictly in order and
// waits out each confirmation (SDK unroll.ts next()), so a chain always reads
// [confirmed…][≤1 mempool][absent…]. The op row narrows the unknowns further:
// waiting/sweepable/swept exist only after Session DONE (= every chain tx
// confirmed), so those states skip status probing entirely — 'waiting' probes
// the vtxo tx once, for the CSV countdown numbers.

export type StepStatus = 'confirmed' | 'mempool' | 'pending' | 'running' | 'sweepable' | 'done'

export interface BroadcastStep {
  kind: 'broadcast'
  txid: string
  txType: ChainTxType
  vsize: number | null
  status: StepStatus
}

export interface WaitStep {
  kind: 'wait'
  status: StepStatus
  need: number
  /** null = not measured yet — the vtxo-tx probe fills in the countdown */
  have: number | null
  unit: 'blocks' | 'seconds'
}

export interface SweepStep {
  kind: 'sweep'
  status: StepStatus
  destAddress: string | null
  sweepTxid: string | null
}

export type ExitStep = BroadcastStep | WaitStep | SweepStep

export interface ExitStepper {
  txid: string
  vout: number
  valueSat: number
  op: ExitOp | null
  proofComplete: boolean
  steps: ExitStep[]
  /** txids for the client to probe in order, stopping at the first non-confirmed */
  probe: string[]
}

/** timelock size/unit from the tapTree alone — the elapsed part needs the chain */
function csvNeedOf(tapTreeHex: string): { need: number; unit: 'blocks' | 'seconds' } | null {
  try {
    const zero = { height: 0, time: 0 }
    const s = csvPathStatuses(tapTreeHex, zero, zero)[0]
    return s ? { need: s.need, unit: s.type } : null
  } catch {
    return null
  }
}

function buildWaitStep(vtxo: VaultVtxo, op: ExitOp | null): WaitStep {
  if (op?.state === 'sweepable' || op?.state === 'swept') {
    return { kind: 'wait', status: 'sweepable', need: 0, have: null, unit: 'blocks' }
  }
  if (op?.state === 'waiting') {
    const csv = csvNeedOf(vtxo.tapTree)
    return {
      kind: 'wait',
      status: 'running',
      need: csv?.need ?? 0,
      have: null,
      unit: csv?.unit ?? 'blocks',
    }
  }
  return { kind: 'wait', status: 'pending', need: 0, have: 0, unit: 'blocks' }
}

function buildSweepStep(op: ExitOp | null, waitStatus: StepStatus): SweepStep {
  return {
    kind: 'sweep',
    status: op?.state === 'swept' ? 'done' : waitStatus === 'sweepable' ? 'sweepable' : 'pending',
    destAddress: op?.destAddress ?? null,
    sweepTxid: op?.sweepTxid ?? null,
  }
}

export function buildExitStepper(
  deps: { db: Database },
  txid: string,
  vout: number,
  feeRate: number,
): ExitStepper | null {
  const vtxo = getVaultVtxo(deps.db, txid, vout)
  if (!vtxo) return null
  const op = getExitOp(deps.db, txid, vout)
  // a corrupt stored PSBT must degrade to unpriced steps, not a 500
  let est = null
  try {
    est = estimateExit(deps.db, txid, vout, feeRate)
  } catch {
    est = null
  }
  const vsizeOf = new Map((est?.txs ?? []).map((t) => [t.txid, t.vsize]))

  // the engine sets waiting/sweepable/swept only after Session DONE — every
  // broadcast step is confirmed by definition, no probing needed
  const unrolled =
    op?.state === 'waiting' || op?.state === 'sweepable' || op?.state === 'swept'

  // chain is indexer order [vtxo tx … commitment]; display root→leaf
  const broadcastOrder = [...vtxo.chain].reverse()

  const steps: ExitStep[] = []
  for (const c of broadcastOrder) {
    if (c.type === ChainTxType.COMMITMENT) {
      steps.push({ kind: 'broadcast', txid: c.txid, txType: c.type, vsize: null, status: 'confirmed' })
      continue
    }
    steps.push({
      kind: 'broadcast',
      txid: c.txid,
      txType: c.type,
      vsize: vsizeOf.get(c.txid) ?? null,
      status: unrolled && c.type !== ChainTxType.UNSPECIFIED ? 'confirmed' : 'pending',
    })
  }

  const waitStep = buildWaitStep(vtxo, op)
  steps.push(waitStep)
  steps.push(buildSweepStep(op, waitStep.status))

  // Session never broadcasts UNSPECIFIED entries, so probing one would
  // falsely stop the scan — probe exactly the set the session broadcasts
  // (proofTxidsOf), in broadcast order
  const probe = unrolled
    ? op?.state === 'waiting'
      ? [vtxo.txid] // countdown numbers only — statuses are already final
      : []
    : proofTxidsOf(broadcastOrder)

  return {
    txid,
    vout,
    valueSat: vtxo.valueSat,
    op,
    proofComplete: est?.proofComplete ?? false,
    steps,
    probe,
  }
}

export interface ExitStepProbe {
  /** the probed step's onchain state — 'pending' = the explorer hasn't seen it */
  status: StepStatus
  step: BroadcastStep
  /** present when the probed tx is the vtxo tx and it confirmed — the CSV countdown is now measurable */
  wait?: WaitStep
  sweep?: SweepStep
}

// One esplora status read per call keeps the endpoint far below any socket
// timeout; a hung explorer degrades to 'pending' instead of stalling.
const PROBE_TIMEOUT_MS = 4_000

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

type TxStatus = { confirmed: boolean; blockHeight?: number; blockTime?: number }

async function txStatus(
  explorer: OnchainProvider,
  txid: string,
  timeoutMs: number,
): Promise<TxStatus | null> {
  try {
    const s = await withTimeout<TxStatus | null>(explorer.getTxStatus(txid), timeoutMs, null)
    if (s === null) return null
    return s.confirmed
      ? { confirmed: true, blockHeight: s.blockHeight, blockTime: s.blockTime }
      : { confirmed: false }
  } catch {
    // getTxStatus throws when the tx isn't in mempool or a block yet
    return null
  }
}

/**
 * Onchain status for a single broadcast step. Returns null when the vtxo is
 * unknown or the txid isn't a broadcastable entry of its chain — that check
 * also keeps the endpoint from being an open esplora proxy.
 */
export async function probeExitStep(
  deps: { db: Database; explorer: OnchainProvider; timeoutMs?: number },
  txid: string,
  vout: number,
  stepTxid: string,
): Promise<ExitStepProbe | null> {
  const vtxo = getVaultVtxo(deps.db, txid, vout)
  if (!vtxo) return null
  const entry = vtxo.chain.find((c) => c.txid === stepTxid)
  if (!entry || entry.type === ChainTxType.COMMITMENT || entry.type === ChainTxType.UNSPECIFIED) {
    return null
  }
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS

  const s = await txStatus(deps.explorer, stepTxid, timeoutMs)
  const status: StepStatus = s === null ? 'pending' : s.confirmed ? 'confirmed' : 'mempool'
  const probe: ExitStepProbe = {
    status,
    step: {
      kind: 'broadcast',
      txid: stepTxid,
      txType: entry.type,
      vsize: storedTxVsize(deps.db, stepTxid, entry.type),
      status,
    },
  }

  // vtxo tx confirmed → the CSV clock is measurable; hand back wait+sweep too
  if (stepTxid === vtxo.txid && s?.confirmed) {
    const tip = await withTimeout(deps.explorer.getChainTip(), timeoutMs, null).catch(() => null)
    if (tip) {
      try {
        const csv = csvPathStatuses(
          vtxo.tapTree,
          { height: s.blockHeight!, time: s.blockTime! },
          tip,
        )[0]
        if (csv) {
          const op = getExitOp(deps.db, txid, vout)
          probe.wait = {
            kind: 'wait',
            status: csv.satisfied ? 'sweepable' : 'running',
            need: csv.need,
            have: Math.max(0, csv.have),
            unit: csv.type,
          }
          probe.sweep = buildSweepStep(op, probe.wait.status)
        }
      } catch {
        // undecodable tapTree — the step status alone is still useful
      }
    }
  }

  return probe
}
