import type { Database } from 'bun:sqlite'
import { hex } from '@scure/base'
import { SigHash, TaprootControlBlock } from '@scure/btc-signer'
import {
  Transaction,
  TxWeightEstimator,
  VtxoScript,
  getNetwork,
  timelockToSequence,
  type Identity,
  type OnchainProvider,
} from '@arkade-os/sdk'
import type { Network } from '../defaults'
import { getVaultVtxo, type VaultVtxo } from './vault'
import { availableExitPath } from './csv'

// The last exit step: spend fully-unrolled vtxos through their CSV exit
// path to a plain address. Local adaptation of the SDK's
// prepareUnrollTransaction (ts-sdk src/wallet/unroll.ts:239) — that one
// reads vtxos and providers off a live Wallet object, which doesn't exist
// in degraded mode; every ingredient here comes from the vault row
// (tapTree/value), esplora (confirmation + fee rate) and the nsec identity.
//
// Batching is fee-sharing only: all inputs land in ONE tx so the output
// overhead is paid once — sub-dust vtxos that could never clear a solo
// sweep ride along. The DECISION to exit stays per-vtxo (§1); by the time
// vtxos are sweepable that decision was already made one by one.

// Same floor the SDK enforces (wallet/utils DUST_AMOUNT — not exported).
const DUST_SAT = 546
const MIN_FEE_RATE = 1 // sat/vB

export interface SweepResult {
  txid: string
  hex: string
  inputCount: number
  amountSat: number
  feeSat: number
}

export interface SweepDeps {
  db: Database
  identity: Identity
  explorer: OnchainProvider
  network: Network
}

/** encoded control-block length: version+parity byte, 32B internal key, 32B per merkle step */
function controlBlockLen(leaf: VaultSpendingLeaf): number {
  return TaprootControlBlock.encode(leaf[0]).length
}

type VaultSpendingLeaf = ReturnType<InstanceType<typeof VtxoScript>['findLeaf']>

interface SweepInput {
  vtxo: VaultVtxo
  leaf: VaultSpendingLeaf
  sequence: number
  pkScript: Uint8Array
}

async function resolveInput(deps: SweepDeps, txid: string, vout: number): Promise<SweepInput> {
  const vtxo = getVaultVtxo(deps.db, txid, vout)
  if (!vtxo) throw new Error(`exit vault has no entry for ${txid}:${vout}`)

  const status = await deps.explorer.getTxStatus(txid)
  if (!status.confirmed) {
    throw new Error(`vtxo tx ${txid} is not confirmed onchain — unroll first`)
  }
  const tip = await deps.explorer.getChainTip()
  const exit = availableExitPath(
    vtxo.tapTree,
    { height: status.blockHeight, time: status.blockTime },
    tip,
  )
  if (!exit) {
    throw new Error(`CSV timelock not elapsed yet for ${txid}:${vout}`)
  }

  const script = VtxoScript.decode(hex.decode(vtxo.tapTree))
  const leaf = script.findLeaf(hex.encode(exit.script))
  if (!leaf) throw new Error(`exit leaf not found in tapTree for ${txid}:${vout}`)

  return {
    vtxo,
    leaf,
    sequence: timelockToSequence(exit.params.timelock),
    pkScript: script.pkScript,
  }
}

/**
 * Build and sign the sweep transaction without broadcasting. minFeeSat is
 * the RBF path: a replacement must beat the stuck tx's absolute fee plus
 * incremental relay, which can exceed what the current rate estimate says —
 * the fee is raised to the floor, never lowered. Throws if any input isn't
 * actually spendable yet or the net amount would be dust.
 */
export async function buildSweepTx(
  deps: SweepDeps,
  outpoints: { txid: string; vout: number }[],
  destAddress: string,
  minFeeSat?: bigint,
): Promise<SweepResult> {
  if (outpoints.length === 0) throw new Error('nothing to sweep')

  const inputs: SweepInput[] = []
  for (const o of outpoints) {
    inputs.push(await resolveInput(deps, o.txid, o.vout))
  }

  const network = getNetwork(deps.network)
  const estimator = TxWeightEstimator.create()
  const tx = new Transaction({ version: 2 })
  let totalSat = 0n
  for (const input of inputs) {
    totalSat += BigInt(input.vtxo.valueSat)
    tx.addInput({
      txid: input.vtxo.txid,
      index: input.vtxo.vout,
      tapLeafScript: [input.leaf],
      sequence: input.sequence,
      witnessUtxo: { amount: BigInt(input.vtxo.valueSat), script: input.pkScript },
      sighashType: SigHash.DEFAULT,
    })
    estimator.addTapscriptInput(64, input.leaf[1].length, controlBlockLen(input.leaf))
  }
  estimator.addOutputAddress(destAddress, network)

  let feeRate = await deps.explorer.getFeeRate()
  if (!feeRate || feeRate < MIN_FEE_RATE) feeRate = MIN_FEE_RATE
  // esplora can report fractional sat/vB; round up so we always pay at
  // least the advertised rate (same guard as the SDK)
  let feeSat = estimator.vsize().fee(BigInt(Math.ceil(feeRate)))
  if (minFeeSat !== undefined && feeSat < minFeeSat) feeSat = minFeeSat
  if (feeSat >= totalSat) {
    throw new Error(
      `sweep fee (${feeSat} sats) would consume the entire value (${totalSat} sats)`,
    )
  }
  const amountSat = totalSat - feeSat
  if (amountSat < BigInt(DUST_SAT)) {
    throw new Error(`sweep output ${amountSat} sats is below dust (${DUST_SAT})`)
  }

  tx.addOutputAddress(destAddress, amountSat, network)
  const signed = await deps.identity.sign(tx)
  signed.finalize()

  return {
    txid: signed.id,
    hex: signed.hex,
    inputCount: inputs.length,
    amountSat: Number(amountSat),
    feeSat: Number(feeSat),
  }
}

/**
 * Build, sign and broadcast the sweep transaction for one or more
 * fully-unrolled, CSV-elapsed vtxos.
 */
export async function sweepVtxos(
  deps: SweepDeps,
  outpoints: { txid: string; vout: number }[],
  destAddress: string,
): Promise<SweepResult> {
  const result = await buildSweepTx(deps, outpoints, destAddress)
  await deps.explorer.broadcastTransaction(result.hex)
  return result
}
