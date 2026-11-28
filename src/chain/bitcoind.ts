import { hex } from '@scure/base'
import type { Coin, ExplorerTransaction, OnchainProvider } from '@arkade-os/sdk'

// The SDK's OnchainProvider over our own bitcoind's JSON-RPC, so the unroll /
// CPFP / sweep machinery (Unroll.Session, OnchainWallet, the exit engine) runs
// with no third party in the path — the same interface EsploraProvider fills
// (F32_VHTLC_PLAN Q2: either backend). Needs txindex=1: confirmed txs are read
// by txid.
//
// Two methods have no bitcoind equivalent and refuse rather than half-work:
// getTransactions (address history) and watchAddresses. The swap executors
// only ever ask about specific txids and outpoints, and the fuel address's
// coins come from scantxoutset.

export interface BitcoindRpcConfig {
  /** e.g. http://172.28.0.1:8332 */
  url: string
  user: string
  password: string
  timeoutMs?: number
}

export class BitcoindRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`bitcoind ${method}: ${message} (${code})`)
    this.name = 'BitcoindRpcError'
  }
}

/** RPC_INVALID_ADDRESS_OR_KEY — getrawtransaction's "No such mempool or blockchain transaction". */
const NOT_FOUND = -5

export class BitcoindRpc {
  private id = 0
  constructor(private readonly cfg: BitcoindRpcConfig) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${this.cfg.user}:${this.cfg.password}`).toString('base64')}`,
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120_000),
    })
    // bitcoind answers RPC errors with 500 and a JSON body; only a non-JSON body is a transport failure.
    const text = await res.text()
    let body: { result?: T; error?: { code: number; message: string } | null }
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`bitcoind ${method}: HTTP ${res.status} ${text.slice(0, 200)}`)
    }
    if (body.error) throw new BitcoindRpcError(method, body.error.code, body.error.message)
    return body.result as T
  }
}

interface RawTxVerbose {
  txid: string
  vin: { txid?: string; vout?: number; txinwitness?: string[] }[]
  vout: unknown[]
  confirmations?: number
  blockhash?: string
}

/** Where an outpoint was spent, with the spending input's witness (the preimage lives there). */
export interface Spender {
  txid: string
  vin: number
  witness: Uint8Array[]
}

const satsFromBtc = (btc: number): number => Math.round(btc * 100_000_000)

/**
 * Core's submitpackage answers success-shaped JSON even when every tx was
 * rejected ({"package_msg":"transaction failed","tx-results":{…"error":…}}),
 * so the verdict has to be read out of it, not off the HTTP status.
 */
export function assertPackageAccepted(result: unknown): void {
  const r = result as { package_msg?: string; 'tx-results'?: Record<string, { error?: string }> }
  const errors = Object.values(r?.['tx-results'] ?? {})
    .map((t) => t.error)
    .filter((e): e is string => typeof e === 'string')
  if (r?.package_msg !== 'success' || errors.length > 0) {
    throw new Error(`package rejected: ${r?.package_msg ?? 'no package_msg'}${errors.length ? ` (${errors.join('; ')})` : ''}`)
  }
}

export class BitcoindOnchainProvider implements OnchainProvider {
  constructor(readonly rpc: BitcoindRpc) {}

  /** UTXO-set scan: confirmed coins only — a fuel deposit needs confirming before it can pay a CPFP anyway. */
  async getCoins(address: string): Promise<Coin[]> {
    const res = await this.rpc.call<{ success: boolean; unspents: { txid: string; vout: number; amount: number; height: number }[] }>(
      'scantxoutset',
      ['start', [`addr(${address})`]],
    )
    if (!res.success) throw new Error(`scantxoutset for ${address} did not complete`)
    return res.unspents.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: satsFromBtc(u.amount),
      status: { confirmed: true, block_height: u.height },
    }))
  }

  async getFeeRate(): Promise<number | undefined> {
    const est = await this.rpc.call<{ feerate?: number }>('estimatesmartfee', [2]).catch(() => undefined)
    // BTC/kvB → sat/vB
    return est?.feerate !== undefined ? (est.feerate * 100_000_000) / 1000 : undefined
  }

  async broadcastTransaction(...txs: string[]): Promise<string> {
    if (txs.length === 1) return this.rpc.call<string>('sendrawtransaction', [txs[0]])
    if (txs.length !== 2) throw new Error('Only 1 or 1C1P package can be broadcast')
    const result = await this.rpc.call<{ 'tx-results': Record<string, { txid: string }> }>('submitpackage', [txs])
    assertPackageAccepted(result)
    const txids = Object.values(result['tx-results']).map((t) => t.txid)
    return txids[txids.length - 1]!
  }

  async getTxOutspends(txid: string): Promise<{ spent: boolean; txid?: string }[]> {
    const tx = await this.verbose(txid)
    return Promise.all(tx.vout.map((_, i) => this.outspendKnownTx(txid, i)))
  }

  async getTxOutspend(txid: string, vout: number): Promise<{ spent: boolean; txid?: string }> {
    await this.verbose(txid) // a missing tx must not read as "spent"
    return this.outspendKnownTx(txid, vout)
  }

  async getTransactions(_address: string): Promise<ExplorerTransaction[]> {
    throw new Error('bitcoind provider: address history is not supported (txindex indexes txids, not addresses)')
  }

  async getRawTransaction(txid: string): Promise<Uint8Array> {
    return hex.decode(await this.rpc.call<string>('getrawtransaction', [txid, false]))
  }

  async getTxStatus(txid: string): Promise<{ confirmed: false } | { confirmed: true; blockTime: number; blockHeight: number }> {
    const tx = await this.verbose(txid)
    if (!tx.confirmations || !tx.blockhash) return { confirmed: false }
    const header = await this.rpc.call<{ height: number; time: number }>('getblockheader', [tx.blockhash])
    return { confirmed: true, blockTime: header.time, blockHeight: header.height }
  }

  async getChainTip(): Promise<{ height: number; time: number; hash: string }> {
    const info = await this.rpc.call<{ blocks: number; bestblockhash: string }>('getblockchaininfo')
    const header = await this.rpc.call<{ time: number }>('getblockheader', [info.bestblockhash])
    return { height: info.blocks, time: header.time, hash: info.bestblockhash }
  }

  async getMedianTimePast(height: number): Promise<number> {
    const hash = await this.rpc.call<string>('getblockhash', [height])
    return (await this.rpc.call<{ mediantime: number }>('getblockheader', [hash])).mediantime
  }

  async watchAddresses(): Promise<() => void> {
    throw new Error('bitcoind provider: address watching is not supported')
  }

  /**
   * The input that spent `txid:vout`, with its witness: the mempool first,
   * then blocks from `fromHeight` up (bitcoind keeps no spend index). Callers
   * pass the height the output confirmed at, so the scan stays short. Undefined
   * while unspent.
   */
  async findSpender(txid: string, vout: number, fromHeight: number): Promise<Spender | undefined> {
    const mem = await this.rpc.call<{ spendingtxid?: string }[]>('gettxspendingprevout', [[{ txid, vout }]])
    const memSpender = mem[0]?.spendingtxid
    if (memSpender) return this.spenderIn(await this.verbose(memSpender), txid, vout)
    if (await this.isUnspent(txid, vout)) return undefined
    const tip = (await this.rpc.call<{ blocks: number }>('getblockchaininfo')).blocks
    for (let h = Math.max(0, fromHeight); h <= tip; h++) {
      const hash = await this.rpc.call<string>('getblockhash', [h])
      const block = await this.rpc.call<{ tx: RawTxVerbose[] }>('getblock', [hash, 2])
      for (const tx of block.tx) {
        const found = this.spenderIn(tx, txid, vout)
        if (found) return found
      }
    }
    return undefined
  }

  private spenderIn(tx: RawTxVerbose, txid: string, vout: number): Spender | undefined {
    const i = tx.vin.findIndex((v) => v.txid === txid && v.vout === vout)
    if (i < 0) return undefined
    return { txid: tx.txid, vin: i, witness: (tx.vin[i]!.txinwitness ?? []).map((w) => hex.decode(w)) }
  }

  private async verbose(txid: string): Promise<RawTxVerbose> {
    return this.rpc.call<RawTxVerbose>('getrawtransaction', [txid, true])
  }

  private async isUnspent(txid: string, vout: number): Promise<boolean> {
    return (await this.rpc.call<unknown>('gettxout', [txid, vout, true])) !== null
  }

  private async outspendKnownTx(txid: string, vout: number): Promise<{ spent: boolean; txid?: string }> {
    if (await this.isUnspent(txid, vout)) return { spent: false }
    // Spent. The mempool names its spender; a confirmed spender has no index
    // here, and the SDK allows `txid` to be absent (findSpender scans for it).
    const mem = await this.rpc.call<{ spendingtxid?: string }[]>('gettxspendingprevout', [[{ txid, vout }]])
    return mem[0]?.spendingtxid ? { spent: true, txid: mem[0].spendingtxid } : { spent: true }
  }
}

export const isNotFound = (e: unknown): boolean => e instanceof BitcoindRpcError && e.code === NOT_FOUND
