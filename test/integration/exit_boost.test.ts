import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  OnchainWallet,
  SingleKey,
  Transaction,
  type Coin,
  type OnchainProvider,
} from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { openTempDb, type TempDb } from '../helpers/db'
import { FIXTURE_CSV_BLOCKS, makeMockChain, makeSignedExitFixture } from '../helpers/exit'
import { storeVtxoWithProofs } from '../../src/exit/vault'
import { createOrRestartExitOp, getExitOp, setExitOpState } from '../../src/exit/ops'
import { getBroadcast, recordBroadcast } from '../../src/exit/broadcasts'
import {
  boostStep,
  boostSweep,
  stepBoostInfo,
  sweepBoostInfo,
  type BoostDeps,
  type MempoolTxInfo,
} from '../../src/exit/boost'
import { startExitEngine, type ExitEngine } from '../../src/exit/engine'

const walletKey = SingleKey.fromPrivateKey(new Uint8Array(32).fill(7))

// Boost needs a state makeMockChain can't express: a tx the explorer KNOWS
// but hasn't confirmed (in mempool). Everything is a hand-set map so tests
// dial in exactly the stuck scenario they mean. Broadcast hexes land in the
// mempool set (the post-broadcast presence check reads it back) unless
// swallowBroadcasts simulates a node that took the POST and dropped the tx.
function mockMempoolExplorer(args: {
  mempool?: string[]
  confirmed?: Record<string, { height: number; time: number }>
  outspends?: Record<string, { spent: boolean; txid?: string }[]>
  feeRate?: number
  tipHeight?: number
  swallowBroadcasts?: boolean
}) {
  const mempool = new Set(args.mempool ?? [])
  const broadcasts: string[][] = []
  const explorer = {
    async getTxStatus(txid: string) {
      const c = args.confirmed?.[txid]
      if (c) return { confirmed: true, blockHeight: c.height, blockTime: c.time }
      if (mempool.has(txid)) return { confirmed: false }
      throw new Error('not found')
    },
    async getTxOutspends(txid: string) {
      const o = args.outspends?.[txid]
      if (!o) throw new Error('not found')
      return o
    },
    async broadcastTransaction(...txs: string[]) {
      broadcasts.push(txs)
      if (!args.swallowBroadcasts) {
        for (const h of txs) {
          mempool.add(
            Transaction.fromRaw(hex.decode(h), {
              allowUnknownOutputs: true,
              allowUnknownInputs: true,
            }).id,
          )
        }
      }
      return 'ok'
    },
    async getChainTip() {
      const height = args.tipHeight ?? 1_000
      return { height, time: height * 600, hash: 'h' }
    },
    async getFeeRate() {
      return args.feeRate ?? 20
    },
  } as unknown as OnchainProvider
  return { explorer, broadcasts }
}

const coin = (txid: string, vout: number, value: number, confirmed: boolean): Coin =>
  ({ txid, vout, value, status: { confirmed } }) as Coin

const FUEL_A = '11'.repeat(32)
const FUEL_B = '22'.repeat(32)
const OLD_CHILD = 'aa'.repeat(32)

describe('exit boost', () => {
  let temp: TempDb
  let engine: ExitEngine | undefined
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    engine?.stop()
    temp.cleanup()
  })

  async function fuelSource(coins: Coin[]) {
    const wallet = await OnchainWallet.create(walletKey, 'bitcoin')
    return {
      address: wallet.address,
      onchainP2TR: wallet.onchainP2TR,
      script: wallet.onchainP2TR.script,
      getCoins: async () => coins,
    }
  }

  async function stuckFixture(args: {
    oldChild?: MempoolTxInfo | null
    /** value of the confirmed prevout the default old child sits on */
    oldChildPrevoutSat?: number
    coins?: Coin[]
    feeRate?: number
    tipHeight?: number
    confirmed?: boolean
    swallowBroadcasts?: boolean
  }) {
    const f = await makeSignedExitFixture(1, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const fuel = await fuelSource(args.coins ?? [coin(FUEL_A, 0, 30_000, true)])
    const mock = mockMempoolExplorer({
      mempool: args.confirmed ? [] : [f.txid],
      confirmed: args.confirmed ? { [f.txid]: { height: 900, time: 900 * 600 } } : {},
      // fixture tx outputs: [0] = the vtxo P2TR, [1] = the anchor
      outspends: {
        [f.txid]: [
          { spent: false },
          args.oldChild === null ? { spent: false } : { spent: true, txid: OLD_CHILD },
        ],
      },
      feeRate: args.feeRate,
      tipHeight: args.tipHeight,
      swallowBroadcasts: args.swallowBroadcasts,
    })
    const oldChild =
      args.oldChild === null
        ? null
        : (args.oldChild ?? {
            feeSat: 200,
            vsize: 120,
            confirmed: false,
            inputs: [
              {
                txid: FUEL_B,
                vout: 0,
                valueSat: args.oldChildPrevoutSat ?? 5_000,
                scriptHex: hex.encode(fuel.script),
              },
            ],
          })
    const deps: BoostDeps = {
      db: temp.db,
      identity: walletKey,
      network: 'bitcoin',
      explorer: mock.explorer,
      fuel,
      reader: {
        tx: async (txid: string) => (txid === OLD_CHILD ? oldChild : null),
        spenderFromAddress: async () => null,
      },
      confirmRetry: { attempts: 2, delayMs: 10 },
    }
    return { f, fuel, mock, deps, oldChild }
  }

  test('stepBoostInfo prices the package and activates on rate alone', async () => {
    const { f, deps } = await stuckFixture({ feeRate: 20, tipHeight: 1_004 })
    recordBroadcast(temp.db, f.txid, f.txid, 0, 1_000)

    const info = await stepBoostInfo(deps, f.txid, 0, f.txid)
    expect(info).not.toBeNull()
    expect(info!.childTxid).toBe(OLD_CHILD)
    expect(info!.childFeeSat).toBe(200)
    // 200 sats over (parent + 120) vB is nowhere near 20 sat/vB
    expect(info!.pkgRateSatVb).toBeLessThan(3)
    expect(info!.targetRateSatVb).toBe(20)
    expect(info!.boostable).toBe(true)
    expect(info!.blocksWaiting).toBe(4)
    expect(info!.projectedFeeSat).toBeGreaterThan(0)
  })

  test('stepBoostInfo does not activate when the package already pays the target rate', async () => {
    const { f, deps } = await stuckFixture({
      feeRate: 2,
      oldChild: {
        feeSat: 5_000, // huge fee over a small package → rate above target
        vsize: 120,
        confirmed: false,
        inputs: [],
      },
    })
    const info = await stepBoostInfo(deps, f.txid, 0, f.txid)
    expect(info!.boostable).toBe(false)
    expect(info!.pkgRateSatVb).toBeGreaterThan(2)
  })

  test('stepBoostInfo degrades to no fee context when the child is unknown', async () => {
    const { f, deps } = await stuckFixture({ oldChild: null })
    const info = await stepBoostInfo(deps, f.txid, 0, f.txid)
    expect(info!.childTxid).toBeNull()
    expect(info!.pkgRateSatVb).toBeNull()
    expect(info!.boostable).toBe(false)
  })

  test('boostStep resubmits [same parent, higher-fee child] and satisfies the RBF floor', async () => {
    const { f, fuel, mock, deps, oldChild } = await stuckFixture({ feeRate: 20 })

    const res = await boostStep(deps, f.txid, 0, f.txid)

    expect(mock.broadcasts).toHaveLength(1)
    const [parentHex, childHex] = mock.broadcasts[0]!
    const parent = Transaction.fromRaw(hex.decode(parentHex!), {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
    })
    expect(parent.id).toBe(f.txid) // byte-identical pre-signed parent, refinalized from the vault

    const child = Transaction.fromRaw(hex.decode(childHex!), {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
    })
    expect(child.version).toBe(3)
    expect(child.id).toBe(res.childTxid)
    expect(child.outputsLength).toBe(1) // change back to the fuel address

    // fee = everything in minus the change out
    const spentOutpoints = new Set<string>()
    for (let i = 0; i < child.inputsLength; i++) {
      const input = child.getInput(i)
      spentOutpoints.add(`${hex.encode(input.txid!)}:${input.index}`)
    }
    expect(spentOutpoints.has(`${f.txid}:1`)).toBe(true) // the anchor

    const changeSat = Number(child.getOutput(0)!.amount)
    const inValues = [...spentOutpoints].reduce((n, key) => {
      if (key === `${f.txid}:1`) return n // anchor is 0
      if (key === `${FUEL_A}:0`) return n + 30_000
      if (key === `${FUEL_B}:0`) return n + 5_000
      throw new Error(`unexpected input ${key}`)
    }, 0)
    const feeSat = inValues - changeSat
    expect(feeSat).toBe(res.feeSat)
    // RBF floor: old child fee + incremental relay for the new size
    expect(feeSat).toBeGreaterThan(oldChild!.feeSat)
    // whole package at the target rate — scure refuses .vsize on the parsed
    // txs (the anchor input's empty witness reads as unfinalized), so weigh
    // them by hand: weight = 3×base + total
    const vsizeOf = (rawHex: string, tx: Transaction): number => {
      const total = hex.decode(rawHex).length
      const base = tx.toBytes(true, false).length
      return Math.ceil((base * 3 + total) / 4)
    }
    expect(feeSat).toBeGreaterThanOrEqual(
      20 * (vsizeOf(parentHex!, parent) + vsizeOf(childHex!, child)),
    )
    // change stays above dust
    expect(changeSat).toBeGreaterThanOrEqual(546)
  })

  test('boostStep spends only confirmed fuel, reclaiming the stuck child\'s own prevouts', async () => {
    const unconfirmedChange = coin('cc'.repeat(32), 1, 100_000, false)
    const { f, mock, deps } = await stuckFixture({
      feeRate: 20,
      // esplora shows ONLY unconfirmed coins — the confirmed fuel is what the
      // stuck child sits on (its own prevout, reported via txInfo inputs)
      coins: [unconfirmedChange],
      oldChildPrevoutSat: 30_000,
    })

    await boostStep(deps, f.txid, 0, f.txid)

    const child = Transaction.fromRaw(hex.decode(mock.broadcasts[0]![1]!), {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
    })
    const spent = new Set<string>()
    for (let i = 0; i < child.inputsLength; i++) {
      spent.add(hex.encode(child.getInput(i).txid!))
    }
    expect(spent.has(FUEL_B)).toBe(true) // old child's confirmed prevout reused
    expect(spent.has('cc'.repeat(32))).toBe(false) // unconfirmed coin excluded
  })

  test('boostStep finds the child via the address scan when outspends omits the spender txid', async () => {
    // mempool.arkade-style backends answer {spent:true} with no txid — the
    // regtest drill hit this live and the boost lost both the RBF floor and
    // the reclaimable prevout (the only fuel). The fallback must recover it.
    const f = await makeSignedExitFixture(1, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const fuel = await fuelSource([]) // esplora shows NO utxos — reclaim or die
    const mock = mockMempoolExplorer({
      mempool: [f.txid],
      outspends: { [f.txid]: [{ spent: false }, { spent: true }] }, // txid omitted
      feeRate: 20,
    })
    const oldChild = {
      feeSat: 200,
      vsize: 120,
      confirmed: false,
      inputs: [{ txid: FUEL_B, vout: 0, valueSat: 30_000, scriptHex: hex.encode(fuel.script) }],
    }
    const deps: BoostDeps = {
      db: temp.db,
      identity: walletKey,
      network: 'bitcoin',
      explorer: mock.explorer,
      fuel,
      reader: {
        tx: async (txid: string) => (txid === OLD_CHILD ? oldChild : null),
        spenderFromAddress: async (address: string, parentTxid: string, vout: number) =>
          address === fuel.address && parentTxid === f.txid && vout === 1 ? OLD_CHILD : null,
      },
    }

    const res = await boostStep(deps, f.txid, 0, f.txid)

    // floor honored (child identified) and the reclaimed prevout paid for it
    expect(res.feeSat).toBeGreaterThan(oldChild.feeSat)
    const child = Transaction.fromRaw(hex.decode(mock.broadcasts[0]![1]!), {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
    })
    const spent = new Set<string>()
    for (let i = 0; i < child.inputsLength; i++) {
      spent.add(hex.encode(child.getInput(i).txid!))
    }
    expect(spent.has(FUEL_B)).toBe(true)
  })

  test('boostStep refuses a blind boost when the in-mempool child is unreadable', async () => {
    // parent demonstrably in the mempool + child unidentifiable (outspends
    // omits the txid AND the address scan misses — the exact esplora-lag
    // combination the regtest drill produced). A rebuild would carry no RBF
    // floor → same fee → same txid → silent no-op. Must refuse instead.
    const { f, mock, deps } = await stuckFixture({ oldChild: null })
    ;(mock as { explorer: OnchainProvider }).explorer.getTxOutspends = async () => [
      { spent: false },
      { spent: true }, // txid omitted
    ]
    expect(boostStep(deps, f.txid, 0, f.txid)).rejects.toThrow('could not be read')
  })

  test('boostStep surfaces a broadcast the node silently dropped', async () => {
    // /txs/package can wrap a submitpackage rejection in a 200 — the only
    // proof of acceptance is the replacement showing up in the mempool
    const { f, deps } = await stuckFixture({ feeRate: 20, swallowBroadcasts: true })
    expect(boostStep(deps, f.txid, 0, f.txid)).rejects.toThrow('did not appear in the mempool')
  })

  test('boostStep throws when confirmed fuel cannot cover the fee', async () => {
    const { f, deps } = await stuckFixture({
      feeRate: 20,
      coins: [coin(FUEL_A, 0, 50, true)],
      oldChild: { feeSat: 200, vsize: 120, confirmed: false, inputs: [] },
    })
    expect(boostStep(deps, f.txid, 0, f.txid)).rejects.toThrow('not enough confirmed exit fuel')
  })

  test('boostStep refuses an already-confirmed step', async () => {
    const { f, deps } = await stuckFixture({ confirmed: true })
    expect(boostStep(deps, f.txid, 0, f.txid)).rejects.toThrow('already confirmed')
  })

  test('boostSweep rebuilds the sweep above the RBF floor and updates every batched op', async () => {
    const f = await makeSignedExitFixture(2, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0)
    const oldSweep = 'dd'.repeat(32)
    setExitOpState(temp.db, f.txid, 0, 'swept', {
      sweepTxid: oldSweep,
      destAddress: 'bc1qs3rlfhcmd5flh6vl48an6mlyqfr5zm3v5kgl2n',
    })
    recordBroadcast(temp.db, oldSweep, f.txid, 0, 990)

    // vtxo tx confirmed 10 blocks ago → CSV (10) elapsed at the mock tip
    const mock = mockMempoolExplorer({
      confirmed: { [f.txid]: { height: 900, time: 900 * 600 } },
      tipHeight: 900 + Number(FIXTURE_CSV_BLOCKS),
      feeRate: 2,
    })

    const fuel = await fuelSource([])
    // old sweep pays 500 sats over ~110 vB — the floor (500 + 110 + 1) beats
    // the 2 sat/vB rate estimate (~280), so the floor must win
    const deps: BoostDeps = {
      db: temp.db,
      identity: walletKey,
      network: 'bitcoin',
      explorer: mock.explorer,
      fuel,
      reader: {
        tx: async (txid: string) =>
          txid === oldSweep ? { feeSat: 500, vsize: 110, confirmed: false, inputs: [] } : null,
        spenderFromAddress: async () => null,
      },
      confirmRetry: { attempts: 2, delayMs: 10 },
    }

    const res = await boostSweep(deps, f.txid, 0)

    expect(res.feeSat).toBe(500 + 110 + 1)
    expect(mock.broadcasts).toHaveLength(1)
    expect(mock.broadcasts[0]).toHaveLength(1) // single tx, not a package

    const op = getExitOp(temp.db, f.txid, 0)
    expect(op?.state).toBe('swept')
    expect(op?.sweepTxid).toBe(res.txid)
    expect(op?.sweepTxid).not.toBe(oldSweep)

    // the wait clock carries over from the FIRST sweep broadcast
    expect(getBroadcast(temp.db, res.txid)?.tipHeight).toBe(990)
  })

  test('boostSweep refuses a confirmed sweep', async () => {
    const f = await makeSignedExitFixture(3, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0)
    setExitOpState(temp.db, f.txid, 0, 'swept', { sweepTxid: OLD_CHILD })

    const chain = makeMockChain()
    const deps: BoostDeps = {
      db: temp.db,
      identity: walletKey,
      network: 'bitcoin',
      explorer: chain.explorer as unknown as OnchainProvider,
      fuel: await fuelSource([]),
      reader: {
        tx: async () => ({ feeSat: 100, vsize: 100, confirmed: true, inputs: [] }),
        spenderFromAddress: async () => null,
      },
    }
    expect(boostSweep(deps, f.txid, 0)).rejects.toThrow('already confirmed')
  })

  test('sweepBoostInfo reports a stuck sweep as boostable', async () => {
    const f = await makeSignedExitFixture(4, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    createOrRestartExitOp(temp.db, f.txid, 0)
    const sweepTxid = 'ee'.repeat(32)
    setExitOpState(temp.db, f.txid, 0, 'swept', { sweepTxid })

    const mock = mockMempoolExplorer({ feeRate: 15, tipHeight: 1_002 })
    recordBroadcast(temp.db, sweepTxid, f.txid, 0, 1_000)
    const deps: BoostDeps = {
      db: temp.db,
      identity: walletKey,
      network: 'bitcoin',
      explorer: mock.explorer,
      fuel: await fuelSource([]),
      reader: {
        tx: async () => ({ feeSat: 110, vsize: 110, confirmed: false, inputs: [] }),
        spenderFromAddress: async () => null,
      },
    }

    const info = await sweepBoostInfo(deps, f.txid, 0)
    expect(info!.rateSatVb).toBe(1)
    expect(info!.targetRateSatVb).toBe(15)
    expect(info!.boostable).toBe(true)
    expect(info!.blocksWaiting).toBe(2)
  })

  test('engine records the broadcast tip height on every UNROLL step', async () => {
    const f = await makeSignedExitFixture(5, { identity: walletKey })
    storeVtxoWithProofs(temp.db, f.vtxo, f.proofs)
    const chain = makeMockChain(1_234)

    engine = startExitEngine({
      db: temp.db,
      identity: walletKey,
      network: 'bitcoin',
      esploraUrls: ['http://127.0.0.1:1/api'],
      providers: {
        bumper: {
          async bumpP2A(parent: Transaction) {
            chain.confirm(parent.id)
            return [parent.hex, '<child>']
          },
        },
        explorer: chain.explorer as unknown as OnchainProvider,
      },
      pollIntervalMs: 60_000,
    })

    engine.startExit(f.txid, 0)
    const t0 = Date.now()
    while (Date.now() - t0 < 10_000) {
      if (getExitOp(temp.db, f.txid, 0)?.state === 'waiting') break
      await new Promise((r) => setTimeout(r, 25))
    }

    const record = getBroadcast(temp.db, f.txid)
    expect(record).not.toBeNull()
    expect(record!.tipHeight).toBe(1_234)
  })
})
