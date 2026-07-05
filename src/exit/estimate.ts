import type { Database } from 'bun:sqlite'
import { base64, hex } from '@scure/base'
import {
  ChainTxType,
  Transaction,
  TxWeightEstimator,
  VtxoScript,
  type ChainTx,
} from '@arkade-os/sdk'
import { getProofPsbts, getVaultVtxo, proofTxidsOf } from './vault'

// Exit cost, computed offline from the vault (EXIT_PLAN #11): the stored
// PSBTs are finalized in memory with the exact rules Unroll.Session applies,
// so per-tx vsizes are measurements, not guesses — the #13 stepper shows the
// same numbers per step and they sum to this estimate. The verdict feeds §1's
// mandate: the user must see "exiting this one loses money" before the
// button, whether it's a 660-sat vtxo or a 53-hop chain at a high fee rate
// (mainnet measurement: ~32,000 vB of packages on one unrefreshed vtxo).

export interface ExitTxEstimate {
  txid: string
  type: ChainTxType
  /** finalized parent vsize; each parent also needs one CPFP child (childVb) */
  vsize: number
}

export interface ExitEstimate {
  txid: string
  vout: number
  valueSat: number
  /** worst case: nothing broadcast yet — every non-commitment chain tx is a 1P1C package */
  txs: ExitTxEstimate[]
  packages: number
  parentVb: number
  /** CPFP child per package (keyspend fee input + P2A + change) */
  childVb: number
  unrollVb: number
  /** solo sweep — batching with other sweepable vtxos shares this part */
  sweepVb: number
  totalVb: number
  feeRateSatVb: number
  unrollFeeSat: number
  sweepFeeSat: number
  totalFeeSat: number
  /** may exceed 100 */
  feePctOfValue: number
  /** exiting burns more than it recovers */
  uneconomical: boolean
  /** false = some proofs were never mirrored; the numbers cover only what's stored */
  proofComplete: boolean
}

// Output size depends only on the script shape; a zeroed P2TR script stands
// in for the real destination (the default dest is P2TR too).
const P2TR_SCRIPT_STANDIN = hex.decode('5120' + '00'.repeat(32))

// Session finalize rules, replayed in memory to measure the real broadcast
// size — TREE carries the round's aggregated tapKeySig, the rest finalize
// from their complete witnesses.
function finalizedVsize(type: ChainTxType, psbtB64: string): number {
  const tx = Transaction.fromPSBT(base64.decode(psbtB64))
  if (type === ChainTxType.TREE) {
    const input = tx.getInput(0)
    if (!input?.tapKeySig) throw new Error('tree tx without tapKeySig')
    tx.updateInput(0, { finalScriptWitness: [input.tapKeySig] })
  } else {
    tx.finalize()
  }
  return tx.vsize
}

function cpfpChildVb(): number {
  return Number(
    TxWeightEstimator.create()
      .addKeySpendInput(true)
      .addP2AInput()
      .addOutputScript(P2TR_SCRIPT_STANDIN)
      .vsize().value,
  )
}

function sweepVbOf(tapTreeHex: string): number {
  const script = VtxoScript.decode(hex.decode(tapTreeHex))
  const exits = script.exitPaths()
  if (exits.length === 0) return 0
  const leaf = script.findLeaf(hex.encode(exits[0]!.script))
  if (!leaf) return 0
  const est = TxWeightEstimator.create()
  // control block: version+parity byte + 32B internal key + 32B per merkle step
  est.addTapscriptInput(64, leaf[1].length, 33 + 32 * leaf[0].merklePath.length)
  est.addOutputScript(P2TR_SCRIPT_STANDIN)
  return Number(est.vsize().value)
}

export function estimateExit(
  db: Database,
  txid: string,
  vout: number,
  feeRateSatVb: number,
): ExitEstimate | null {
  const vtxo = getVaultVtxo(db, txid, vout)
  if (!vtxo) return null

  const wanted = proofTxidsOf(vtxo.chain)
  const psbts = getProofPsbts(db, wanted)
  const typeOf = new Map(vtxo.chain.map((c: ChainTx) => [c.txid, c.type]))

  const txs: ExitTxEstimate[] = []
  let proofComplete = true
  for (const id of wanted) {
    const psbt = psbts.get(id)
    if (!psbt) {
      proofComplete = false
      continue
    }
    txs.push({ txid: id, type: typeOf.get(id)!, vsize: finalizedVsize(typeOf.get(id)!, psbt) })
  }

  const rate = Math.max(1, Math.ceil(feeRateSatVb))
  const childVb = cpfpChildVb()
  const parentVb = txs.reduce((n, t) => n + t.vsize, 0)
  const unrollVb = parentVb + childVb * txs.length
  const sweepVb = sweepVbOf(vtxo.tapTree)
  const totalVb = unrollVb + sweepVb
  const unrollFeeSat = unrollVb * rate
  const sweepFeeSat = sweepVb * rate
  const totalFeeSat = unrollFeeSat + sweepFeeSat

  return {
    txid,
    vout,
    valueSat: vtxo.valueSat,
    txs,
    packages: txs.length,
    parentVb,
    childVb,
    unrollVb,
    sweepVb,
    totalVb,
    feeRateSatVb: rate,
    unrollFeeSat,
    sweepFeeSat,
    totalFeeSat,
    feePctOfValue: vtxo.valueSat > 0 ? Math.round((totalFeeSat / vtxo.valueSat) * 100) : Infinity,
    uneconomical: totalFeeSat >= vtxo.valueSat,
    proofComplete,
  }
}
