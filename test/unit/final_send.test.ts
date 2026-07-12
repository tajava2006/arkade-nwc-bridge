import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { SingleKey, Transaction } from '@arkade-os/sdk'
import { p2tr } from '@scure/btc-signer'
import { NETWORK } from '@scure/btc-signer/utils.js'
import { hex } from '@scure/base'
import type { OnchainProvider } from '@arkade-os/sdk'
import type { BoostDeps, EsploraReader, MempoolTxInfo } from '../../src/exit/boost'
import { boostFinalSend, finalSend } from '../../src/exit/final_send'
import { getExitDest, issueDestChallenge } from '../../src/exit/dest'
import { openTempDb, type TempDb } from '../helpers/db'

// Exact-fee send-all math + the RBF rebuild, against fakes: no network, the
// tx itself is decoded and checked (inputs, single output, amounts, RBF
// sequence). Live-fire coverage belongs to the regtest drill.

const priv = new Uint8Array(32).fill(21)
const identity = SingleKey.fromPrivateKey(priv)
const fuelP2TR = p2tr(schnorr.getPublicKey(priv), undefined, NETWORK)
const DEST = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l' // any valid mainnet addr

interface Coin {
  txid: string
  vout: number
  value: number
  status: { confirmed: boolean }
}

function makeDeps(opts: {
  coins: Coin[]
  feeRate?: number
  txInfo?: (txid: string) => MempoolTxInfo | null
  presence?: 'confirmed' | 'mempool' | 'unknown'
}) {
  const broadcasts: string[] = []
  const explorer = {
    getFeeRate: async () => opts.feeRate ?? 3,
    broadcastTransaction: async (...txs: string[]) => {
      broadcasts.push(...txs)
    },
    getTxStatus: async () => {
      if ((opts.presence ?? 'mempool') === 'unknown') throw new Error('not found')
      return { confirmed: (opts.presence ?? 'mempool') === 'confirmed' }
    },
    getChainTip: async () => ({ height: 100 }),
  } as unknown as OnchainProvider
  const reader: EsploraReader = {
    tx: async (txid: string) => opts.txInfo?.(txid) ?? null,
    // unused by final send
    outspend: async () => null,
    rawTxHex: async () => null,
  } as unknown as EsploraReader
  const deps = (db: TempDb['db']): BoostDeps =>
    ({
      db,
      identity,
      network: 'bitcoin',
      explorer,
      reader,
      fuel: {
        address: fuelP2TR.address!,
        onchainP2TR: { script: fuelP2TR.script, tapInternalKey: fuelP2TR.tapInternalKey },
        getCoins: async () => opts.coins,
      },
      confirmRetry: { attempts: 1, delayMs: 1 },
    }) as BoostDeps
  return { deps, broadcasts }
}

let tmp: TempDb
beforeEach(() => {
  tmp = openTempDb()
  const issued = issueDestChallenge(tmp.db, 'bitcoin', DEST)
  if (!issued.ok) throw new Error('issue failed')
  // signature ceremony is dest.test.ts's subject — stamp verified directly
  tmp.db.query(`UPDATE exit_dest SET verified_at = 1, scheme = 'test' WHERE id = 1`).run()
})
afterEach(() => tmp.cleanup())

const coin = (n: number, value: number, confirmed = true): Coin => ({
  txid: n.toString(16).padStart(64, '0'),
  vout: 0,
  value,
  status: { confirmed },
})

describe('finalSend', () => {
  test('sweeps all confirmed coins to the verified dest, exact fee, no change', async () => {
    const { deps, broadcasts } = makeDeps({
      coins: [coin(1, 40_000), coin(2, 25_000), coin(3, 10_000, false)],
      feeRate: 3,
    })
    const result = await finalSend(deps(tmp.db))

    expect(result.inputCount).toBe(2) // unconfirmed coin excluded
    expect(result.amountSat + result.feeSat).toBe(65_000)
    expect(broadcasts).toEqual([result.hex])
    expect(getExitDest(tmp.db)!.sendTxid).toBe(result.txid)

    const tx = Transaction.fromRaw(hex.decode(result.hex), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    })
    expect(tx.inputsLength).toBe(2)
    expect(tx.outputsLength).toBe(1) // no change output
    expect(Number(tx.getOutput(0)!.amount)).toBe(result.amountSat)
    expect(tx.getInput(0)!.sequence).toBe(0xfffffffd) // RBF signalled
    // fee = ceil(vsize * rate): recompute from the actual signed tx
    expect(result.feeSat).toBeGreaterThanOrEqual(Math.ceil((tx.vsize ?? 0) * 3))
  })

  test('refuses when everything is unconfirmed', async () => {
    const { deps } = makeDeps({ coins: [coin(1, 40_000, false)] })
    expect(finalSend(deps(tmp.db))).rejects.toThrow('no confirmed coins')
  })

  test('refuses when the fee would eat the value', async () => {
    const { deps } = makeDeps({ coins: [coin(1, 200)], feeRate: 10 })
    expect(finalSend(deps(tmp.db))).rejects.toThrow(/consume the entire value|below dust/)
  })

  test('refuses a second send while one is in the mempool', async () => {
    const { deps } = makeDeps({ coins: [coin(1, 40_000)], presence: 'mempool' })
    const d = deps(tmp.db)
    await finalSend(d)
    expect(finalSend(d)).rejects.toThrow('already in the mempool')
  })
})

describe('boostFinalSend', () => {
  test('rebuilds from the stuck tx inputs and pays the BIP-125 floor', async () => {
    const first = makeDeps({ coins: [coin(1, 40_000), coin(2, 25_000)], feeRate: 3 })
    const d1 = first.deps(tmp.db)
    const sent = await finalSend(d1)

    // after broadcast the utxo endpoint hides the spent coins; the boost
    // must recover them from the stuck tx itself
    const oldTx = Transaction.fromRaw(hex.decode(sent.hex), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    })
    const values = new Map([
      [coin(1, 0).txid, 40_000],
      [coin(2, 0).txid, 25_000],
    ])
    const oldInputs = [0, 1].map((i) => {
      const inp = oldTx.getInput(i)!
      const txid = hex.encode(inp.txid!)
      return {
        txid,
        vout: inp.index!,
        valueSat: values.get(txid)!,
        scriptHex: hex.encode(fuelP2TR.script),
      }
    })
    const second = makeDeps({
      coins: [], // spent-in-mempool → utxo endpoint returns nothing
      feeRate: 3, // rate unchanged — the floor must still force a higher fee
      txInfo: () => ({
        feeSat: sent.feeSat,
        vsize: oldTx.vsize,
        confirmed: false,
        inputs: oldInputs,
      }),
    })
    const boosted = await boostFinalSend(second.deps(tmp.db))

    expect(boosted.inputCount).toBe(2)
    expect(boosted.feeSat).toBeGreaterThan(sent.feeSat) // RBF rule 4 floor
    expect(boosted.txid).not.toBe(sent.txid)
    expect(getExitDest(tmp.db)!.sendTxid).toBe(boosted.txid)
  })

  test('refuses to boost blind when the mempool tx cannot be priced', async () => {
    const { deps } = makeDeps({ coins: [coin(1, 40_000)], presence: 'mempool' })
    const d = deps(tmp.db)
    await finalSend(d)
    expect(boostFinalSend(d)).rejects.toThrow('boosting blind')
  })

  test('refuses to boost a confirmed send', async () => {
    const sentDeps = makeDeps({ coins: [coin(1, 40_000)] })
    const d = sentDeps.deps(tmp.db)
    const sent = await finalSend(d)
    const after = makeDeps({
      coins: [],
      txInfo: () => ({ feeSat: sent.feeSat, vsize: 111, confirmed: true, inputs: [] }),
    })
    expect(boostFinalSend(after.deps(tmp.db))).rejects.toThrow('already confirmed')
  })
})
