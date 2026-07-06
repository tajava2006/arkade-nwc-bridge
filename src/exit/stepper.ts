import type { Database } from 'bun:sqlite'
import { ChainTxType, type OnchainProvider } from '@arkade-os/sdk'
import { getVaultVtxo } from './vault'
import { getExitOp, type ExitOp } from './ops'
import { estimateExit } from './estimate'
import { csvPathStatuses } from './csv'

// The visual model behind requirement 10: a vertical stepper that answers
// "how many broadcasts, where am I, how much longer". Broadcast steps run
// root→leaf (commitment, always onchain → … → the vtxo tx), each tagged with
// its onchain state and measured vsize (same numbers the #11 estimate sums);
// then the CSV wait with a live countdown; then the sweep. Computed on demand
// from the vault + esplora — no ASP.

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
  have: number
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
}

async function txStatus(
  explorer: OnchainProvider,
  txid: string,
): Promise<{ confirmed: boolean; blockHeight?: number; blockTime?: number } | null> {
  try {
    const s = await explorer.getTxStatus(txid)
    return s.confirmed
      ? { confirmed: true, blockHeight: s.blockHeight, blockTime: s.blockTime }
      : { confirmed: false }
  } catch {
    // getTxStatus throws when the tx isn't in mempool or a block yet
    return null
  }
}

export async function buildExitStepper(
  deps: { db: Database; explorer: OnchainProvider },
  txid: string,
  vout: number,
  feeRate: number,
): Promise<ExitStepper | null> {
  const vtxo = getVaultVtxo(deps.db, txid, vout)
  if (!vtxo) return null
  const op = getExitOp(deps.db, txid, vout)
  const est = estimateExit(deps.db, txid, vout, feeRate)
  const vsizeOf = new Map((est?.txs ?? []).map((t) => [t.txid, t.vsize]))

  // chain is indexer order [vtxo tx … commitment]; display root→leaf
  const broadcastOrder = [...vtxo.chain].reverse()

  const steps: ExitStep[] = []
  let vtxoTxConfirmedAt: { height: number; time: number } | null = null
  for (const c of broadcastOrder) {
    if (c.type === ChainTxType.COMMITMENT) {
      steps.push({ kind: 'broadcast', txid: c.txid, txType: c.type, vsize: null, status: 'confirmed' })
      continue
    }
    const s = await txStatus(deps.explorer, c.txid)
    const status: StepStatus = s === null ? 'pending' : s.confirmed ? 'confirmed' : 'mempool'
    if (c.txid === txid && s?.confirmed) {
      vtxoTxConfirmedAt = { height: s.blockHeight!, time: s.blockTime! }
    }
    steps.push({
      kind: 'broadcast',
      txid: c.txid,
      txType: c.type,
      vsize: vsizeOf.get(c.txid) ?? null,
      status,
    })
  }

  // CSV wait — only measurable once the vtxo tx itself is confirmed onchain
  let waitStep: WaitStep
  if (vtxoTxConfirmedAt) {
    const tip = await deps.explorer.getChainTip()
    const csv = csvPathStatuses(vtxo.tapTree, vtxoTxConfirmedAt, tip)[0]
    if (csv) {
      waitStep = {
        kind: 'wait',
        status: csv.satisfied ? 'sweepable' : 'running',
        need: csv.need,
        have: Math.max(0, csv.have),
        unit: csv.type,
      }
    } else {
      waitStep = { kind: 'wait', status: 'pending', need: 0, have: 0, unit: 'blocks' }
    }
  } else {
    waitStep = { kind: 'wait', status: 'pending', need: 0, have: 0, unit: 'blocks' }
  }
  steps.push(waitStep)

  steps.push({
    kind: 'sweep',
    status: op?.state === 'swept' ? 'done' : waitStep.status === 'sweepable' ? 'sweepable' : 'pending',
    destAddress: op?.destAddress ?? null,
    sweepTxid: op?.sweepTxid ?? null,
  })

  return {
    txid,
    vout,
    valueSat: vtxo.valueSat,
    op,
    proofComplete: est?.proofComplete ?? false,
    steps,
  }
}
