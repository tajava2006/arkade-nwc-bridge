import type { Database } from 'bun:sqlite'
import type { IndexerProvider, Outpoint, VtxoChain } from '@arkade-os/sdk'
import { getProofPsbts, getVaultVtxo } from './vault'

// The offline stand-in for the ASP's indexer (EXIT_PLAN §2.1): Unroll.Session
// re-fetches each PSBT via getVirtualTxs at every step, and that is the ONLY
// indexer method the whole unroll path touches — so serving it from the vault
// makes the SDK's session work with the ASP dead, no reimplementation.
// getVtxoChain is also served (Session.create-style callers), everything else
// throws loudly: if some future SDK version starts calling another method
// mid-unroll, the engine must fail with a message that says what happened,
// not limp into a half-broadcast exit. `implements IndexerProvider` is the
// drift guard — an SDK bump that reshapes the interface fails typecheck here.

function offlineUnavailable(method: string): never {
  throw new Error(
    `VaultIndexer.${method}: not available offline — the exit path serves only locally mirrored proofs`,
  )
}

export class VaultIndexer implements IndexerProvider {
  constructor(private readonly db: Database) {}

  async getVirtualTxs(txids: string[]): Promise<{ txs: string[] }> {
    const stored = getProofPsbts(this.db, txids)
    const txs = txids.map((txid) => {
      const psbt = stored.get(txid)
      if (!psbt) {
        // never serve a partial answer — a missing proof means this vtxo was
        // not fully mirrored before the outage and its exit cannot proceed
        throw new Error(`exit vault has no proof for tx ${txid}`)
      }
      return psbt
    })
    return { txs }
  }

  async getVtxoChain(outpoint: Outpoint): Promise<VtxoChain> {
    const vtxo = getVaultVtxo(this.db, outpoint.txid, outpoint.vout)
    if (!vtxo) {
      throw new Error(`exit vault has no chain for ${outpoint.txid}:${outpoint.vout}`)
    }
    return { chain: vtxo.chain }
  }

  getVtxoTree(): never {
    offlineUnavailable('getVtxoTree')
  }
  getVtxoTreeLeaves(): never {
    offlineUnavailable('getVtxoTreeLeaves')
  }
  getBatchSweepTransactions(): never {
    offlineUnavailable('getBatchSweepTransactions')
  }
  getCommitmentTx(): never {
    offlineUnavailable('getCommitmentTx')
  }
  getCommitmentTxConnectors(): never {
    offlineUnavailable('getCommitmentTxConnectors')
  }
  getCommitmentTxForfeitTxs(): never {
    offlineUnavailable('getCommitmentTxForfeitTxs')
  }
  getSubscription(): never {
    offlineUnavailable('getSubscription')
  }
  getVtxos(): never {
    offlineUnavailable('getVtxos')
  }
  getAssetDetails(): never {
    offlineUnavailable('getAssetDetails')
  }
  subscribeForScripts(): never {
    offlineUnavailable('subscribeForScripts')
  }
  unsubscribeForScripts(): never {
    offlineUnavailable('unsubscribeForScripts')
  }
}
