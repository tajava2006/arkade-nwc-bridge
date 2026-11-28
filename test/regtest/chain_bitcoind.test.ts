import '../../src/polyfills'
import { describe, expect, test } from 'bun:test'
import { hex } from '@scure/base'
import { EsploraProvider } from '@arkade-os/sdk'
import { BitcoindOnchainProvider, BitcoindRpc } from '../../src/chain/bitcoind'
import { findSpender } from '../../src/chain/spender'

// The two chain backends answer the same questions the same way, on the
// regtest chain (arkade-regtest's bitcoind runs txindex=1 like production).
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/chain_bitcoind.test.ts

const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'
const BITCOIND = process.env.REGTEST_BITCOIND_URL ?? 'http://localhost:18443'
const RUN = !!process.env.SUBDUSTD_URL // the harness is up

describe.skipIf(!RUN)('bitcoind and esplora backends agree on regtest', () => {
  const rpc = new BitcoindRpc({ url: BITCOIND, user: 'admin1', password: '123' })
  const btc = new BitcoindOnchainProvider(rpc)
  const esplora = new EsploraProvider(ESPLORA, { forcePolling: true })

  /** A confirmed, non-coinbase tx from the recent chain and the outpoint it spends. */
  const recentSpend = async () => {
    const tip = (await rpc.call<{ blocks: number }>('getblockchaininfo')).blocks
    for (let h = tip - 1; h > tip - 200; h--) {
      const block = await rpc.call<{ tx: { txid: string; vin: { txid?: string; vout?: number; txinwitness?: string[] }[] }[] }>('getblock', [
        await rpc.call<string>('getblockhash', [h]),
        2,
      ])
      const tx = block.tx.find((t) => t.vin[0]?.txid && (t.vin[0].txinwitness?.length ?? 0) > 0)
      if (tx) {
        const parentStatus = await btc.getTxStatus(tx.vin[0]!.txid!)
        if (parentStatus.confirmed) return { tx, height: h, prev: { txid: tx.vin[0]!.txid!, vout: tx.vin[0]!.vout! }, parentHeight: parentStatus.blockHeight }
      }
    }
    throw new Error('no witness spend in the last 200 blocks')
  }

  test('tip and MTP', async () => {
    const [a, b] = await Promise.all([btc.getChainTip(), esplora.getChainTip()])
    expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(1) // a block may land between the two reads
    expect(await btc.getMedianTimePast(a.height - 1)).toBe(await esplora.getMedianTimePast!(a.height - 1))
  }, 60_000)

  test('a confirmed spend: same status, same spender, same witness from both', async () => {
    const s = await recentSpend()
    expect(await btc.getTxStatus(s.tx.txid)).toEqual(await esplora.getTxStatus(s.tx.txid))
    const viaBtc = await findSpender(btc, s.prev.txid, s.prev.vout, s.parentHeight)
    expect(viaBtc?.txid).toBe(s.tx.txid)
    expect(viaBtc?.witness.map((w) => hex.encode(w))).toEqual(s.tx.vin[0]!.txinwitness)
    // The harness's "esplora" is mempool's bitcoind-only backend: no spend index,
    // so it says spent but not by whom. mainnet mempool.space names the spender
    // (checked 2026-11-28); here only the refusal is pinned.
    const viaEsplora = await findSpender(esplora, s.prev.txid, s.prev.vout, s.parentHeight).catch((e: Error) => e)
    if (viaEsplora instanceof Error) expect(viaEsplora.message).toContain("doesn't name the spender")
    else expect(viaEsplora?.txid).toBe(s.tx.txid)
    expect((await btc.getTxOutspend(s.prev.txid, s.prev.vout)).spent).toBe(true)
    expect(hex.encode(await btc.getRawTransaction(s.tx.txid))).toBe(hex.encode(await esplora.getRawTransaction(s.tx.txid)))
  }, 120_000)

  test('getCoins on a funded address matches esplora', async () => {
    const addr = await rpc.call<string>('getnewaddress', ['', 'bech32m']).catch(async () => {
      await rpc.call('createwallet', ['chain-test'])
      return rpc.call<string>('getnewaddress', ['', 'bech32m'])
    })
    await rpc.call('generatetoaddress', [1, addr])
    const deadline = Date.now() + 30_000
    let viaEsplora: { txid: string; vout: number; value: number }[] = []
    while (Date.now() < deadline && viaEsplora.length === 0) {
      viaEsplora = await esplora.getCoins(addr)
      if (viaEsplora.length === 0) await Bun.sleep(1000)
    }
    const viaBtc = await btc.getCoins(addr)
    const key = (c: { txid: string; vout: number; value: number }) => `${c.txid}:${c.vout}:${c.value}`
    expect(viaBtc.map(key).sort()).toEqual(viaEsplora.map(key).sort())
  }, 60_000)
})
