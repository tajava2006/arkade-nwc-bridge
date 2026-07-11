import type { Database } from 'bun:sqlite'
import { hex } from '@scure/base'
import {
  ChainTxType,
  Transaction,
  TxWeightEstimator,
  getNetwork,
  type Coin,
  type Identity,
  type OnchainProvider,
} from '@arkade-os/sdk'
import type { Network } from '../defaults'
import { getVaultVtxo, getProofPsbts } from './vault'
import { finalizeProofTx } from './estimate'
import { getBroadcast, recordBroadcast } from './broadcasts'
import { getExitOp, listOpsBySweepTxid, setExitOpState } from './ops'
import { buildSweepTx, type SweepResult } from './sweep'

// Fee re-boost for a stuck exit (EXIT_DESIGN §boost). The pre-signed parent
// is immutable and zero-fee forever, so "bumping" always means REPLACING the
// CPFP child: a new v3 child spending the same anchor conflicts with the old
// one and rides in via RBF (v3 txs signal replaceability, BIP431). We always
// resubmit [same parent hex, new child] as a package — bitcoind dedupes an
// in-mempool parent and the same call also recovers a fully evicted package.
//
// The SDK's own bumpP2A is unusable here on purpose: it has no fee floor
// (RBF demands old fee + incremental relay × new size, whatever the estimate
// says), it swallows broadcast errors, and its coin selection can pick
// unconfirmed outputs — the old child's change (spends an output of the tx
// being replaced → invalid) or another mempool coin (a second unconfirmed
// parent → v3 topology violation). Fuel here is confirmed-only, with the old
// child's own confirmed prevouts as first choice (an RBF replacement may
// reuse the inputs of the tx it replaces — often the only fuel available,
// since esplora hides coins the stuck child is sitting on).

const ANCHOR_SCRIPT = hex.decode('51024e73')
const ANCHOR_SCRIPT_HEX = '51024e73'
// same floor sweep.ts uses (SDK DUST_AMOUNT is not exported)
const DUST_SAT = 546
// bitcoind's default incrementalrelayfee, sat/vB — RBF rule 4
const INCREMENTAL_RELAY = 1
// BIP431: a TRUC child may not exceed 1000 vB
const TRUC_CHILD_MAX_VB = 1000
const MAX_FEE_ITERATIONS = 10

/** the nsec P2TR that pays CPFP fees — OnchainWallet satisfies this structurally */
export interface FuelSource {
  address: string
  onchainP2TR: { script: Uint8Array; tapInternalKey?: Uint8Array }
  getCoins(): Promise<Coin[]>
}

/** what the boost path reads off one mempool tx — see esploraTxInfo */
export interface MempoolTxInfo {
  feeSat: number
  vsize: number
  confirmed: boolean
  /** prevouts with their scripts, for reclaiming the stuck child's own fuel */
  inputs: { txid: string; vout: number; valueSat: number; scriptHex: string }[]
}

export type TxInfoFn = (txid: string) => Promise<MempoolTxInfo | null>

/**
 * Fee/weight/prevouts of a single tx via the raw esplora endpoint — the SDK
 * provider has no method for this. null on any failure: fee context degrades
 * to "unknown", it never blocks the page.
 */
export function esploraTxInfo(baseUrl: string, timeoutMs = 5_000): TxInfoFn {
  return async (txid) => {
    try {
      const res = await fetch(`${baseUrl}/tx/${txid}`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) return null
      const j = (await res.json()) as {
        fee?: number
        weight?: number
        status?: { confirmed?: boolean }
        vin?: {
          txid?: string
          vout?: number
          prevout?: { scriptpubkey?: string; value?: number } | null
        }[]
      }
      if (typeof j.fee !== 'number' || typeof j.weight !== 'number') return null
      const inputs = (j.vin ?? []).flatMap((v) =>
        typeof v.txid === 'string' &&
        typeof v.vout === 'number' &&
        typeof v.prevout?.value === 'number' &&
        typeof v.prevout?.scriptpubkey === 'string'
          ? [
              {
                txid: v.txid,
                vout: v.vout,
                valueSat: v.prevout.value,
                scriptHex: v.prevout.scriptpubkey,
              },
            ]
          : [],
      )
      return {
        feeSat: j.fee,
        vsize: Math.ceil(j.weight / 4),
        confirmed: Boolean(j.status?.confirmed),
        inputs,
      }
    } catch {
      return null
    }
  }
}

export interface BoostDeps {
  db: Database
  identity: Identity
  network: Network
  explorer: OnchainProvider
  fuel: FuelSource
  txInfo: TxInfoFn
}

/** fee context of one in-mempool 1P1C package — everything the boost UI shows */
export interface StepBoostInfo {
  stepTxid: string
  parentVb: number
  childTxid: string | null
  childFeeSat: number | null
  childVb: number | null
  /** child fee spread over parent+child; the number miners actually see */
  pkgRateSatVb: number | null
  /** next-block estimate the package competes against (floor 1) */
  targetRateSatVb: number
  /** the one activation rule: package rate is below the next-block estimate */
  boostable: boolean
  /** rough replacement child fee — button label material, not a quote */
  projectedFeeSat: number | null
  blocksWaiting: number | null
}

async function nextBlockRate(explorer: OnchainProvider): Promise<number> {
  try {
    const rate = await explorer.getFeeRate()
    return Math.max(1, Math.ceil(rate ?? 1))
  } catch {
    return 1
  }
}

async function tipHeightOrNull(explorer: OnchainProvider): Promise<number | null> {
  try {
    return (await explorer.getChainTip()).height
  } catch {
    return null
  }
}

function anchorIndexOf(tx: Transaction): number {
  for (let i = 0; i < tx.outputsLength; i++) {
    const script = tx.getOutput(i)?.script
    if (script && hex.encode(script) === ANCHOR_SCRIPT_HEX) return i
  }
  throw new Error('no P2A anchor output on the parent tx')
}

function blocksWaitingOf(
  db: Database,
  stepTxid: string,
  tipHeight: number | null,
): number | null {
  const record = getBroadcast(db, stepTxid)
  if (record?.tipHeight == null || tipHeight === null) return null
  return Math.max(0, tipHeight - record.tipHeight)
}

/** RBF rule 4: the replacement pays the old absolute fee plus incremental relay for its own size */
function rbfFloor(old: MempoolTxInfo | null, newVb: number): number {
  return old ? old.feeSat + INCREMENTAL_RELAY * newVb + 1 : 0
}

function loadProofTx(
  db: Database,
  txid: string,
  vout: number,
  stepTxid: string,
): { type: ChainTxType; psbtB64: string } {
  const vtxo = getVaultVtxo(db, txid, vout)
  if (!vtxo) throw new Error(`no vault entry for ${txid}:${vout}`)
  const entry = vtxo.chain.find((c) => c.txid === stepTxid)
  if (!entry || entry.type === ChainTxType.COMMITMENT || entry.type === ChainTxType.UNSPECIFIED) {
    throw new Error(`${stepTxid} is not a broadcastable step of this vtxo`)
  }
  const psbtB64 = getProofPsbts(db, [stepTxid]).get(stepTxid)
  if (!psbtB64) throw new Error(`proof PSBT for ${stepTxid} is not in the vault`)
  return { type: entry.type, psbtB64 }
}

/** the CPFP child currently riding the parent's anchor, found live via the outspend */
async function currentChild(
  deps: Pick<BoostDeps, 'explorer' | 'txInfo'>,
  stepTxid: string,
  anchorIdx: number,
): Promise<{ txid: string; info: MempoolTxInfo | null } | null> {
  try {
    const outspends = await deps.explorer.getTxOutspends(stepTxid)
    const spend = outspends[anchorIdx]
    // some esploras omit the spender txid — treat as unidentifiable, the
    // caller then degrades to "no fee context" instead of guessing
    if (!spend?.spent || !spend.txid) return null
    return { txid: spend.txid, info: await deps.txInfo(spend.txid) }
  } catch {
    return null
  }
}

/**
 * Fee context for one broadcast step. Returns null when the step can't be
 * priced (no vault proof, esplora down) — the UI then shows the plain
 * mempool line without boost affordances.
 */
export async function stepBoostInfo(
  deps: BoostDeps,
  txid: string,
  vout: number,
  stepTxid: string,
): Promise<StepBoostInfo | null> {
  let proof
  try {
    proof = loadProofTx(deps.db, txid, vout, stepTxid)
  } catch {
    return null
  }

  let parent
  try {
    parent = finalizeProofTx(proof.type, proof.psbtB64)
  } catch {
    return null
  }
  const parentVb = parent.vsize
  const child = await currentChild(deps, stepTxid, anchorIndexOf(parent))

  const targetRate = await nextBlockRate(deps.explorer)
  const tip = await tipHeightOrNull(deps.explorer)

  const childVb = child?.info?.vsize ?? null
  const childFee = child?.info?.feeSat ?? null
  const pkgRate =
    childVb !== null && childFee !== null
      ? Math.round((childFee / (parentVb + childVb)) * 10) / 10
      : null

  return {
    stepTxid,
    parentVb,
    childTxid: child?.txid ?? null,
    childFeeSat: childFee,
    childVb,
    pkgRateSatVb: pkgRate,
    targetRateSatVb: targetRate,
    boostable: pkgRate !== null && pkgRate < targetRate,
    projectedFeeSat:
      childVb !== null && child?.info
        ? Math.max(Math.ceil(targetRate * (parentVb + childVb)), rbfFloor(child.info, childVb))
        : null,
    blocksWaiting: blocksWaitingOf(deps.db, stepTxid, tip),
  }
}

interface FuelCoin {
  txid: string
  vout: number
  valueSat: number
}

/**
 * Coins the replacement child may spend: the stuck child's own confirmed
 * prevouts (invisible to the UTXO endpoint while it sits on them) plus the
 * wallet's confirmed UTXOs. Unconfirmed coins are excluded wholesale — a v3
 * child gets exactly one unconfirmed parent (the tree tx), and spending the
 * old child's change would be spending an output of the tx being replaced.
 */
async function fuelPool(
  fuel: FuelSource,
  oldChild: MempoolTxInfo | null,
): Promise<FuelCoin[]> {
  const fuelScriptHex = hex.encode(fuel.onchainP2TR.script)
  const pool = new Map<string, FuelCoin>()
  for (const input of oldChild?.inputs ?? []) {
    if (input.scriptHex !== fuelScriptHex) continue
    pool.set(`${input.txid}:${input.vout}`, {
      txid: input.txid,
      vout: input.vout,
      valueSat: input.valueSat,
    })
  }
  for (const coin of await fuel.getCoins()) {
    if (!coin.status.confirmed) continue
    pool.set(`${coin.txid}:${coin.vout}`, { txid: coin.txid, vout: coin.vout, valueSat: coin.value })
  }
  return [...pool.values()].sort((a, b) => b.valueSat - a.valueSat)
}

function selectFuel(pool: FuelCoin[], targetSat: number): FuelCoin[] {
  const selected: FuelCoin[] = []
  let total = 0
  for (const coin of pool) {
    selected.push(coin)
    total += coin.valueSat
    if (total >= targetSat) return selected
  }
  throw new Error(
    `not enough confirmed exit fuel: need ${targetSat} sats, have ${total} — top up the fuel address (or wait for its pending change to confirm)`,
  )
}

function childVbOf(fuelInputs: number, address: string, network: Network): number {
  const est = TxWeightEstimator.create().addP2AInput()
  for (let i = 0; i < fuelInputs; i++) est.addKeySpendInput(true)
  est.addOutputAddress(address, getNetwork(network))
  return Number(est.vsize().value)
}

export interface BoostStepResult {
  childTxid: string
  feeSat: number
  pkgRateSatVb: number
}

/**
 * Replace the CPFP child of one in-mempool (or evicted) exit package with a
 * higher-fee one and resubmit [same parent, new child]. Fee = whichever is
 * higher of "whole package at the next-block rate" and the RBF floor.
 * Throws loudly on any failure — a silent no-op here costs the user blocks.
 */
export async function boostStep(
  deps: BoostDeps,
  txid: string,
  vout: number,
  stepTxid: string,
): Promise<BoostStepResult> {
  const proof = loadProofTx(deps.db, txid, vout, stepTxid)
  const parent = finalizeProofTx(proof.type, proof.psbtB64)
  const parentVb = parent.vsize
  const anchorIdx = anchorIndexOf(parent)

  try {
    const status = await deps.explorer.getTxStatus(stepTxid)
    if (status.confirmed) throw new Error(`${stepTxid} is already confirmed — nothing to boost`)
  } catch (err) {
    if (err instanceof Error && err.message.includes('already confirmed')) throw err
    // not found = evicted; the package resubmit below recovers it
  }

  const child = await currentChild(deps, stepTxid, anchorIdx)
  if (child?.info?.confirmed) {
    throw new Error(`anchor spender ${child.txid} is already confirmed — nothing to boost`)
  }
  const oldInfo = child?.info ?? null

  const targetRate = await nextBlockRate(deps.explorer)
  const pool = await fuelPool(deps.fuel, oldInfo)

  // fee ↔ input-count fixpoint, same shape as the SDK's
  // estimateFeesAndSelectCoins: accept as soon as the recomputed fee stops
  // growing (selection then already covers it, change stays ≥ dust)
  let feeSat = 0
  let selected: FuelCoin[] | null = null
  let childVb = 0
  for (let i = 0; i < MAX_FEE_ITERATIONS; i++) {
    const candidate = selectFuel(pool, feeSat + DUST_SAT)
    const vb = childVbOf(candidate.length, deps.fuel.address, deps.network)
    if (vb > TRUC_CHILD_MAX_VB) {
      throw new Error(
        `boost child would be ${vb} vB — over the ${TRUC_CHILD_MAX_VB} vB v3 limit; consolidate the fuel address into fewer coins first`,
      )
    }
    const needed = Math.max(Math.ceil(targetRate * (parentVb + vb)), rbfFloor(oldInfo, vb))
    if (needed <= feeSat) {
      selected = candidate
      childVb = vb
      feeSat = needed
      break
    }
    feeSat = needed
  }
  if (!selected) throw new Error('boost fee estimation did not converge')

  const totalIn = selected.reduce((n, c) => n + c.valueSat, 0)
  const changeSat = BigInt(totalIn - feeSat)

  const childTx = new Transaction({ version: 3, allowLegacyWitnessUtxo: true })
  childTx.addInput({
    txid: stepTxid,
    index: anchorIdx,
    witnessUtxo: { script: ANCHOR_SCRIPT, amount: 0n },
  })
  for (const coin of selected) {
    childTx.addInput({
      txid: coin.txid,
      index: coin.vout,
      witnessUtxo: { script: deps.fuel.onchainP2TR.script, amount: BigInt(coin.valueSat) },
      tapInternalKey: deps.fuel.onchainP2TR.tapInternalKey,
    })
  }
  childTx.addOutputAddress(deps.fuel.address, changeSat, getNetwork(deps.network))

  const signed = await deps.identity.sign(childTx)
  // the anchor input (0) is anyone-can-spend with an empty witness — only
  // the fuel inputs finalize, exactly like the SDK's bumpP2A
  for (let i = 1; i < signed.inputsLength; i++) signed.finalizeIdx(i)

  await deps.explorer.broadcastTransaction(parent.hex, signed.hex)

  return {
    childTxid: signed.id,
    feeSat,
    pkgRateSatVb: Math.round((feeSat / (parentVb + childVb)) * 10) / 10,
  }
}

export interface SweepBoostInfo {
  sweepTxid: string
  confirmed: boolean
  feeSat: number
  vsize: number
  rateSatVb: number
  targetRateSatVb: number
  boostable: boolean
  projectedFeeSat: number
  blocksWaiting: number | null
}

/**
 * Fee context of the sweep tx once an op is 'swept'. null when there is no
 * sweep or esplora can't price it — the UI keeps the plain "swept" line.
 */
export async function sweepBoostInfo(
  deps: BoostDeps,
  txid: string,
  vout: number,
): Promise<SweepBoostInfo | null> {
  const op = getExitOp(deps.db, txid, vout)
  if (!op?.sweepTxid) return null
  const info = await deps.txInfo(op.sweepTxid)
  if (!info) return null

  const targetRate = await nextBlockRate(deps.explorer)
  const tip = await tipHeightOrNull(deps.explorer)
  const rate = Math.round((info.feeSat / info.vsize) * 10) / 10

  return {
    sweepTxid: op.sweepTxid,
    confirmed: info.confirmed,
    feeSat: info.feeSat,
    vsize: info.vsize,
    rateSatVb: rate,
    targetRateSatVb: targetRate,
    boostable: !info.confirmed && rate < targetRate,
    projectedFeeSat: Math.max(Math.ceil(targetRate * info.vsize), rbfFloor(info, info.vsize)),
    blocksWaiting: blocksWaitingOf(deps.db, op.sweepTxid, tip),
  }
}

/**
 * RBF the sweep: rebuild the same spend (same vtxo inputs, same destination
 * — the replacement's shape barely changes, only the fee grows out of the
 * output) and update every op the batched sweep settled. The sweep pays its
 * own fee, so no fuel is involved; the CSV sequence already signals BIP125.
 */
export async function boostSweep(deps: BoostDeps, txid: string, vout: number): Promise<SweepResult> {
  const op = getExitOp(deps.db, txid, vout)
  if (op?.state !== 'swept' || !op.sweepTxid) {
    throw new Error(`${txid}:${vout} has no sweep to boost (state: ${op?.state ?? 'no exit op'})`)
  }
  const oldInfo = await deps.txInfo(op.sweepTxid)
  if (oldInfo?.confirmed) {
    throw new Error(`sweep ${op.sweepTxid} is already confirmed — nothing to boost`)
  }

  const batch = listOpsBySweepTxid(deps.db, op.sweepTxid)
  const ops = batch.length > 0 ? batch : [op]
  const dest = ops.find((o) => o.destAddress)?.destAddress ?? deps.fuel.address

  // replacement has the same inputs/output shape, so the old vsize stands in
  // for the new one in the floor
  const minFee = oldInfo ? BigInt(rbfFloor(oldInfo, oldInfo.vsize)) : undefined
  const result = await buildSweepTx(
    { db: deps.db, identity: deps.identity, explorer: deps.explorer, network: deps.network },
    ops.map((o) => ({ txid: o.txid, vout: o.vout })),
    dest,
    minFee,
  )
  await deps.explorer.broadcastTransaction(result.hex)

  for (const o of ops) {
    setExitOpState(deps.db, o.txid, o.vout, 'swept', { sweepTxid: result.txid, destAddress: dest })
  }
  // the wait started at the FIRST sweep broadcast — carry its height forward
  const old = getBroadcast(deps.db, op.sweepTxid)
  recordBroadcast(
    deps.db,
    result.txid,
    txid,
    vout,
    old?.tipHeight ?? (await tipHeightOrNull(deps.explorer)),
  )
  return result
}
