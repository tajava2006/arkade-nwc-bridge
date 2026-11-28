import { hex } from '@scure/base'
import { Transaction, type OnchainProvider } from '@arkade-os/sdk'
import { BitcoindOnchainProvider, type Spender } from './bitcoind'

export type { Spender } from './bitcoind'

/**
 * The input that spent `txid:vout` on chain, with its witness — how a swap
 * learns a preimage revealed by an on-chain claim. Either backend: bitcoind
 * scans (no spend index) from `fromHeight`; an esplora names the spender and
 * the raw tx is parsed here. Undefined while unspent.
 */
export async function findSpender(
  provider: OnchainProvider,
  txid: string,
  vout: number,
  fromHeight: number,
): Promise<Spender | undefined> {
  if (provider instanceof BitcoindOnchainProvider) return provider.findSpender(txid, vout, fromHeight)
  const out = provider.getTxOutspend ? await provider.getTxOutspend(txid, vout) : (await provider.getTxOutspends(txid))[vout]
  if (!out?.spent) return undefined
  // An esplora without a spend index (mempool's bitcoind-only backend, as in the
  // regtest harness) says "spent" but not by whom. mempool.space names it.
  if (!out.txid) {
    throw new Error(`${txid}:${vout} is spent but the provider doesn't name the spender — use bitcoind or an esplora with a spend index`)
  }
  // The SDK's Transaction, never scure's own decoder (it drops fields and rejects P2A outputs).
  const tx = Transaction.fromRaw(await provider.getRawTransaction(out.txid), { allowUnknownOutputs: true })
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i)
    if (input.txid && hex.encode(input.txid) === txid && input.index === vout) {
      return { txid: out.txid, vin: i, witness: input.finalScriptWitness ?? [] }
    }
  }
  throw new Error(`${out.txid} was named as the spender of ${txid}:${vout} but doesn't spend it`)
}
