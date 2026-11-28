import { afterEach, describe, expect, test } from 'bun:test'
import { hex } from '@scure/base'
import { assertPackageAccepted, BitcoindOnchainProvider, BitcoindRpc, BitcoindRpcError } from '../../src/chain/bitcoind'
import { findSpender } from '../../src/chain/spender'

// The bitcoind OnchainProvider against a scripted JSON-RPC: each method's
// answer comes from `rpc`, errors as bitcoind sends them (HTTP 500 + JSON).

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

type Handler = (params: any[]) => unknown
const NOT_FOUND = { __error: { code: -5, message: 'No such mempool or blockchain transaction' } }

function fakeBitcoind(rpc: Record<string, Handler>) {
  const calls: { method: string; params: any[] }[] = []
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body))
    calls.push({ method, params })
    const h = rpc[method]
    if (!h) throw new Error(`unexpected rpc ${method}`)
    const result = h(params) as any
    if (result?.__error) return new Response(JSON.stringify({ result: null, error: result.__error }), { status: 500 })
    return new Response(JSON.stringify({ result, error: null }), { status: 200 })
  }) as unknown as typeof fetch
  return { provider: new BitcoindOnchainProvider(new BitcoindRpc({ url: 'http://btc.invalid', user: 'u', password: 'p' })), calls }
}

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)

describe('BitcoindOnchainProvider', () => {
  test('getCoins: scantxoutset BTC → sats, confirmed with height', async () => {
    const { provider, calls } = fakeBitcoind({
      scantxoutset: () => ({ success: true, unspents: [{ txid: A, vout: 1, amount: 0.00012345, height: 900_000 }] }),
    })
    expect(await provider.getCoins('bc1pfuel')).toEqual([{ txid: A, vout: 1, value: 12_345, status: { confirmed: true, block_height: 900_000 } }])
    expect(calls[0]!.params).toEqual(['start', ['addr(bc1pfuel)']])
  })

  // bitcoind runs one scantxoutset node-wide: ours queue, and another
  // process's scan (-8) is waited out rather than failing an unroll.
  test('getCoins: concurrent scans are queued; a scan already in progress elsewhere is waited out', async () => {
    let running = 0
    let peak = 0
    let busy = 1 // the node is busy with someone else's scan for the first try
    const { provider } = fakeBitcoind({
      scantxoutset: (params) => {
        if (busy-- > 0) return { __error: { code: -8, message: 'Scan already in progress, use action "abort" or "status"' } }
        running++
        peak = Math.max(peak, running)
        running--
        return { success: true, unspents: [{ txid: A, vout: Number(params[1][0].length % 2), amount: 0.0001, height: 1 }] }
      },
    })
    const all = await Promise.all([provider.getCoins('bc1pa'), provider.getCoins('bc1pbb'), provider.getCoins('bc1pccc')])
    expect(all.map((c) => c.length)).toEqual([1, 1, 1])
    expect(peak).toBe(1)
  })

  test('getCoins: another error is not retried', async () => {
    const { provider, calls } = fakeBitcoind({ scantxoutset: () => ({ __error: { code: -1, message: 'boom' } }) })
    await expect(provider.getCoins('bc1pa')).rejects.toThrow('boom')
    expect(calls.length).toBe(1)
  })

  test('getFeeRate: estimatesmartfee BTC/kvB → sat/vB; no estimate → undefined', async () => {
    expect(await fakeBitcoind({ estimatesmartfee: () => ({ feerate: 0.00012 }) }).provider.getFeeRate()).toBeCloseTo(12)
    expect(await fakeBitcoind({ estimatesmartfee: () => ({ errors: ['Insufficient data'] }) }).provider.getFeeRate()).toBeUndefined()
  })

  test('broadcast: one tx → sendrawtransaction; two → submitpackage, and a rejected package throws', async () => {
    const one = fakeBitcoind({ sendrawtransaction: () => A })
    expect(await one.provider.broadcastTransaction('00')).toBe(A)
    const ok = fakeBitcoind({
      submitpackage: () => ({ package_msg: 'success', 'tx-results': { w1: { txid: A }, w2: { txid: B } } }),
    })
    expect(await ok.provider.broadcastTransaction('p', 'c')).toBe(B) // the child
    const bad = fakeBitcoind({
      submitpackage: () => ({ package_msg: 'transaction failed', 'tx-results': { w1: { txid: A, error: 'bad-txns-inputs-missingorspent' } } }),
    })
    expect(await bad.provider.broadcastTransaction('p', 'c').catch((e) => e.message)).toContain('missingorspent')
  })

  test('assertPackageAccepted: success with no per-tx error only', () => {
    expect(() => assertPackageAccepted({ package_msg: 'success', 'tx-results': { w: { txid: A } } })).not.toThrow()
    expect(() => assertPackageAccepted({ package_msg: 'success', 'tx-results': { w: { txid: A, error: 'x' } } })).toThrow()
    expect(() => assertPackageAccepted({})).toThrow()
  })

  test('outspend: unspent / spent in the mempool (spender named) / spent in a block (spender unknown)', async () => {
    const base = { getrawtransaction: () => ({ txid: A, vin: [], vout: [{}, {}] }) }
    expect(await fakeBitcoind({ ...base, gettxout: () => ({ value: 1 }) }).provider.getTxOutspend(A, 0)).toEqual({ spent: false })
    expect(
      await fakeBitcoind({ ...base, gettxout: () => null, gettxspendingprevout: () => [{ txid: A, vout: 0, spendingtxid: B }] }).provider.getTxOutspend(A, 0),
    ).toEqual({ spent: true, txid: B })
    expect(await fakeBitcoind({ ...base, gettxout: () => null, gettxspendingprevout: () => [{ txid: A, vout: 0 }] }).provider.getTxOutspend(A, 0)).toEqual({ spent: true })
  })

  test('a tx that does not exist is an error, never "spent"', async () => {
    const { provider } = fakeBitcoind({ getrawtransaction: () => NOT_FOUND, gettxout: () => null })
    const err = await provider.getTxOutspend(A, 0).catch((e) => e)
    expect(err).toBeInstanceOf(BitcoindRpcError)
    expect(err.code).toBe(-5)
  })

  test('getTxStatus: mempool → unconfirmed; confirmed → its block height and time', async () => {
    expect(await fakeBitcoind({ getrawtransaction: () => ({ txid: A, vin: [], vout: [] }) }).provider.getTxStatus(A)).toEqual({ confirmed: false })
    const conf = fakeBitcoind({
      getrawtransaction: () => ({ txid: A, vin: [], vout: [], confirmations: 3, blockhash: C }),
      getblockheader: () => ({ height: 900_010, time: 1_800_000_000 }),
    })
    expect(await conf.provider.getTxStatus(A)).toEqual({ confirmed: true, blockHeight: 900_010, blockTime: 1_800_000_000 })
  })

  test('chain tip and MTP', async () => {
    const { provider } = fakeBitcoind({
      getblockchaininfo: () => ({ blocks: 900_020, bestblockhash: C }),
      getblockheader: () => ({ time: 1_800_000_600, mediantime: 1_800_000_000 }),
      getblockhash: () => C,
    })
    expect(await provider.getChainTip()).toEqual({ height: 900_020, time: 1_800_000_600, hash: C })
    expect(await provider.getMedianTimePast(900_020)).toBe(1_800_000_000)
  })

  test('address history and watching refuse instead of half-working', async () => {
    const { provider } = fakeBitcoind({})
    expect(await provider.getTransactions('bc1p').catch((e) => e.message)).toContain('not supported')
    expect(await provider.watchAddresses().catch((e) => e.message)).toContain('not supported')
  })
})

describe('findSpender', () => {
  const witness = ['0a0b', 'beef']

  test('bitcoind, mempool: the named spender and its input witness', async () => {
    const { provider } = fakeBitcoind({
      gettxspendingprevout: () => [{ txid: A, vout: 1, spendingtxid: B }],
      getrawtransaction: () => ({ txid: B, vin: [{ txid: C, vout: 0 }, { txid: A, vout: 1, txinwitness: witness }], vout: [] }),
    })
    const s = await findSpender(provider, A, 1, 0)
    expect(s?.txid).toBe(B)
    expect(s?.vin).toBe(1)
    expect(s?.witness.map((w) => hex.encode(w))).toEqual(witness)
  })

  test('bitcoind, confirmed: scans blocks from the given height', async () => {
    const heights: number[] = []
    const { provider } = fakeBitcoind({
      gettxspendingprevout: () => [{ txid: A, vout: 1 }],
      gettxout: () => null,
      getblockchaininfo: () => ({ blocks: 102 }),
      getblockhash: ([h]) => {
        heights.push(h)
        return `hash${h}`
      },
      getblock: ([hash]) =>
        hash === 'hash102'
          ? { tx: [{ txid: B, vin: [{ txid: A, vout: 1, txinwitness: witness }], vout: [] }] }
          : { tx: [{ txid: C, vin: [{ txid: C, vout: 0 }], vout: [] }] },
    })
    const s = await findSpender(provider, A, 1, 100)
    expect(heights).toEqual([100, 101, 102])
    expect(s?.txid).toBe(B)
    expect(s?.witness.map((w) => hex.encode(w))).toEqual(witness)
  })

  test('bitcoind: unspent → undefined without scanning', async () => {
    const { provider, calls } = fakeBitcoind({ gettxspendingprevout: () => [{ txid: A, vout: 1 }], gettxout: () => ({ value: 1 }) })
    expect(await findSpender(provider, A, 1, 0)).toBeUndefined()
    expect(calls.map((c) => c.method)).not.toContain('getblock')
  })
})
