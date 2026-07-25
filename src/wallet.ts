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

// The SDK's backstop-renewal window — FIXED at 1h, deliberately NOT scaled
// with auto_refresh.ts's window. A backstop only needs to fire when the
// primary loop is broken and the deadline is close; scaling it up buys
// nothing and arms a footgun: the SDK's renewal guard is a mere 30s
// cooldown (VtxoManager.RENEWAL_COOLDOWN_MS, re-triggered on every
// vtxo_received), so any threshold ≥ the tree expiry loops a settlement
// round per minute. 1h is safely below any expiry config we'd ever run.
// Invariant: this < AUTO_REFRESH_THRESHOLD_SECONDS (tested).
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
    // consolidate-all auto-refresh (src/auto_refresh.ts, window 3d) —
    // this SDK renewal sits far inside it, so it fires only if that loop
    // failed repeatedly, and then saves just the expiring VTXO (partial
    // renew, sub-dust/swept riders included).
    // Only vtxoThreshold is overridden; boardingUtxoSweep / pollIntervalMs /
    // deprecatedSignerMigration fall back to their defaults (the SDK reads each
    // field with `?? DEFAULT_SETTLEMENT_CONFIG.*`). Seconds, not ms.
    settlementConfig: { vtxoThreshold: VTXO_RENEW_THRESHOLD_SECONDS },
  })

  const address = await wallet.getAddress()
  return { identity, wallet, address }
}
