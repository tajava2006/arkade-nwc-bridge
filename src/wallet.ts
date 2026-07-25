import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  SingleKey,
  Wallet,
} from '@arkade-os/sdk'
import type { Config } from './config'

export interface ArkContext {
  identity: SingleKey
  wallet: Wallet
  address: string
}

// THE renewal knob (see the settlementConfig comment below). The bridge's
// consolidate-all auto-refresh derives its window from this — twice this
// value (auto_refresh.ts) — so changing this one number moves both layers
// together and the loop always fires ahead of the SDK backstop.
export const VTXO_RENEW_THRESHOLD_SECONDS = 3600

export async function initArkWallet(cfg: Config, privateKey: Uint8Array): Promise<ArkContext> {
  const identity = SingleKey.fromPrivateKey(privateKey)

  const wallet = await Wallet.create({
    identity,
    arkServerUrl: cfg.arkServerUrl,
    // Pin the wallet's esplora to our own priority list instead of the
    // SDK's ASP-network-derived default (mempool.arkade.sh). The exit path
    // (src/exit/) reads chain state from the same list, so normal mode and
    // ASP-dead mode agree on what's confirmed — and a config.json override
    // (e.g. a self-hosted mempool) retargets both at once.
    esploraUrl: cfg.esploraUrls[0],
    // Node has no IndexedDB; rebuild local caches from the indexer on each
    // boot. We have our own sqlite in src/db.ts for bridge-level state
    // (connections, payments, invoices) — that's a separate concern.
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    // BACKSTOP renewal only. The primary path is the bridge's own
    // consolidate-all auto-refresh (src/auto_refresh.ts, threshold 2h) —
    // this SDK renewal sits 1h inside it, so it fires only if that loop
    // failed repeatedly, and then saves just the expiring VTXO (partial
    // renew, sub-dust/swept riders included). The SDK default of 3 days
    // stays overridden: against our 2-week tree expiry it would fire
    // renewal rounds far too eagerly — every round is an onchain
    // commitment tx the ASP pays miner fees for.
    // Only vtxoThreshold is overridden; boardingUtxoSweep / pollIntervalMs /
    // deprecatedSignerMigration fall back to their defaults (the SDK reads each
    // field with `?? DEFAULT_SETTLEMENT_CONFIG.*`). Seconds, not ms.
    settlementConfig: { vtxoThreshold: VTXO_RENEW_THRESHOLD_SECONDS },
  })

  const address = await wallet.getAddress()
  return { identity, wallet, address }
}
