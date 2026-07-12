import { Transaction, TxWeightEstimator, getNetwork } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import {
  blocksWaitingOf,
  confirmInMempool,
  nextBlockRate,
  rbfFloor,
  tipHeightOrNull,
  txPresence,
  type BoostDeps,
  type MempoolTxInfo,
} from './boost'
import { getBroadcast, recordBroadcast } from './broadcasts'
import { getExitDest, markDestSent, type ExitDest } from './dest'

// The very last exit step: everything the exit accumulated on the fuel P2TR
// (initial CPFP funding change + every vtxo sweep output) goes to the
// challenge-verified destination in ONE tx. Exact-fee, no change: the fee
// is worked backwards from the final tx shape (N key-path inputs, one
// output) at the current next-block rate, and the output gets the rest.
//
// Inputs signal RBF, so a stuck send is replaced, not chained onto: the
// boost rebuilds from the STUCK TX'S OWN inputs (once a send is in the
// mempool the esplora utxo endpoint no longer lists the coins it spends —
// asking getCoins again would find nothing) plus any coins that landed on
// the fuel address since, and pays the BIP-125 floor over the old fee.

const DUST_SAT = 546
/** unconfirmed fuel coins are excluded: their parent (usually our own sweep) is RBF-able, and a replacement would orphan this tx */
const RBF_SEQUENCE = 0xfffffffd

export interface FinalSendResult {
  txid: string
  hex: string
  inputCount: number
  amountSat: number
  feeSat: number
}

interface FuelCoinRef {
  txid: string
  vout: number
  valueSat: number
}

async function confirmedFuelCoins(deps: BoostDeps): Promise<FuelCoinRef[]> {
  const coins = await deps.fuel.getCoins()
  return coins
    .filter((c) => c.status.confirmed)
    .map((c) => ({ txid: c.txid, vout: c.vout, valueSat: c.value }))
}

interface BuiltFinalSend {
  tx: Transaction
  inputCount: number
  amountSat: number
  feeSat: number
}

function buildTx(
  deps: BoostDeps,
  coins: FuelCoinRef[],
  destAddress: string,
  feeRate: number,
  rbfAgainst: MempoolTxInfo | null,
): BuiltFinalSend {
  if (coins.length === 0) throw new Error('no confirmed coins on the fuel address')

  const network = getNetwork(deps.network)
  const estimator = TxWeightEstimator.create()
  const tx = new Transaction({ version: 2 })
  let totalSat = 0n
  for (const coin of coins) {
    totalSat += BigInt(coin.valueSat)
    tx.addInput({
      txid: coin.txid,
      index: coin.vout,
      witnessUtxo: { script: deps.fuel.onchainP2TR.script, amount: BigInt(coin.valueSat) },
      tapInternalKey: deps.fuel.onchainP2TR.tapInternalKey,
      sequence: RBF_SEQUENCE,
    })
    estimator.addKeySpendInput()
  }
  estimator.addOutputAddress(destAddress, network)

  const vsize = Number(estimator.vsize().value)
  let feeSat = BigInt(Math.ceil(vsize * feeRate))
  const floor = BigInt(rbfFloor(rbfAgainst, vsize))
  if (feeSat < floor) feeSat = floor
  if (feeSat >= totalSat) {
    throw new Error(`final send fee (${feeSat} sats) would consume the entire value (${totalSat} sats)`)
  }
  const amountSat = totalSat - feeSat
  if (amountSat < BigInt(DUST_SAT)) {
    throw new Error(`final send output ${amountSat} sats is below dust (${DUST_SAT})`)
  }
  tx.addOutputAddress(destAddress, amountSat, network)
  return {
    tx,
    inputCount: coins.length,
    amountSat: Number(amountSat),
    feeSat: Number(feeSat),
  }
}

async function signAndBroadcast(
  deps: BoostDeps,
  built: BuiltFinalSend,
  what: string,
): Promise<FinalSendResult> {
  const signed = await deps.identity.sign(built.tx)
  signed.finalize()
  await deps.explorer.broadcastTransaction(signed.hex)
  await confirmInMempool(deps, signed.id, what)
  return {
    txid: signed.id,
    hex: signed.hex,
    inputCount: built.inputCount,
    amountSat: built.amountSat,
    feeSat: built.feeSat,
  }
}

function requireVerifiedDest(deps: BoostDeps): ExitDest {
  const dest = getExitDest(deps.db)
  if (!dest?.verifiedAt) {
    throw new Error('no verified destination — complete the challenge signature first')
  }
  return dest
}

export async function finalSend(deps: BoostDeps): Promise<FinalSendResult> {
  const dest = requireVerifiedDest(deps)
  if (dest.sendTxid) {
    const presence = await txPresence(deps.explorer, dest.sendTxid)
    if (presence === 'mempool') {
      throw new Error(
        `final send ${dest.sendTxid} is already in the mempool — boost it instead of sending again`,
      )
    }
    // confirmed → sending what accumulated since is a fresh send;
    // unknown → evicted, a rebuild at the current rate is correct
  }
  const coins = await confirmedFuelCoins(deps)
  const built = buildTx(deps, coins, dest.address, await nextBlockRate(deps.explorer), null)
  const result = await signAndBroadcast(deps, built, 'final send')
  markDestSent(deps.db, result.txid)
  recordBroadcast(deps.db, result.txid, result.txid, -1, await tipHeightOrNull(deps.explorer))
  return result
}

export interface FinalSendInfo {
  sendTxid: string
  confirmed: boolean
  feeSat: number
  vsize: number
  rateSatVb: number
  targetRateSatVb: number
  boostable: boolean
  blocksWaiting: number | null
}

/** fee context of the last final send; null when there is none or esplora can't price it */
export async function finalSendInfo(deps: BoostDeps): Promise<FinalSendInfo | null> {
  const dest = getExitDest(deps.db)
  if (!dest?.sendTxid) return null
  const info = await deps.reader.tx(dest.sendTxid)
  if (!info) return null
  const targetRate = await nextBlockRate(deps.explorer)
  const rate = Math.round((info.feeSat / info.vsize) * 10) / 10
  return {
    sendTxid: dest.sendTxid,
    confirmed: info.confirmed,
    feeSat: info.feeSat,
    vsize: info.vsize,
    rateSatVb: rate,
    targetRateSatVb: targetRate,
    boostable: !info.confirmed && rate < targetRate,
    blocksWaiting: blocksWaitingOf(deps.db, dest.sendTxid, await tipHeightOrNull(deps.explorer)),
  }
}

export async function boostFinalSend(deps: BoostDeps): Promise<FinalSendResult> {
  const dest = requireVerifiedDest(deps)
  if (!dest.sendTxid) throw new Error('no final send to boost — send first')
  const oldInfo = await deps.reader.tx(dest.sendTxid)
  if (oldInfo?.confirmed) {
    throw new Error(`final send ${dest.sendTxid} is already confirmed — nothing to boost`)
  }
  if (!oldInfo) {
    // same blind-RBF trap as the sweep boost: unreadable-but-present means
    // no floor, and a same-fee rebuild is the SAME txid — a silent no-op
    const presence = await txPresence(deps.explorer, dest.sendTxid)
    if (presence === 'confirmed') {
      throw new Error(`final send ${dest.sendTxid} is already confirmed — nothing to boost`)
    }
    if (presence === 'mempool') {
      throw new Error(
        `the final send is in the mempool but its fee could not be read from esplora — boosting blind would change nothing; retry in a few seconds`,
      )
    }
  }

  // Rebuild from the stuck tx's own fuel inputs (the utxo endpoint hides
  // coins a mempool tx spends), then add anything that landed since.
  const fuelScriptHex = hex.encode(deps.fuel.onchainP2TR.script)
  const coins: FuelCoinRef[] = (oldInfo?.inputs ?? [])
    .filter((i) => i.scriptHex === fuelScriptHex)
    .map((i) => ({ txid: i.txid, vout: i.vout, valueSat: i.valueSat }))
  const seen = new Set(coins.map((c) => `${c.txid}:${c.vout}`))
  for (const c of await confirmedFuelCoins(deps)) {
    if (!seen.has(`${c.txid}:${c.vout}`)) coins.push(c)
  }

  const built = buildTx(deps, coins, dest.address, await nextBlockRate(deps.explorer), oldInfo)
  const result = await signAndBroadcast(deps, built, 'replacement final send')
  markDestSent(deps.db, result.txid)
  // the wait started at the FIRST broadcast — carry its height forward
  const old = getBroadcast(deps.db, dest.sendTxid)
  recordBroadcast(deps.db, result.txid, result.txid, -1, old?.tipHeight ?? (await tipHeightOrNull(deps.explorer)))
  return result
}
