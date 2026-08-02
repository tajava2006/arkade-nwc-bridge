import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  SingleKey,
  Wallet,
  type ExtendedVirtualCoin,
  type GetVtxosFilter,
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

/**
 * The default-filter semantics `getVtxos` documents but does not deliver:
 * `withUnrolled: false` is consulted only after `hasTerminalSpend`, and an
 * unrolled-but-unspent vtxo is NOT terminal (arkd sets `spent` on offchain
 * spends only), so it short-circuits into every "spendable" result. arkd
 * never reclassifies such a row either — the batch sweeper explicitly skips
 * unrolled leaves — so without this filter the exited vtxo haunts balance,
 * /send and settle() input selection forever, and one ghost input makes the
 * consolidate-all intent rejected wholesale (VTXO_ALREADY_UNROLLED, observed
 * mainnet 2026-08-01). arkd's own `spendableOnly` filter and its bundled Go
 * client both already treat unrolled as spent; this applies the same rule.
 */
export function withoutUnrolled(
  vtxos: ExtendedVirtualCoin[],
  filter?: GetVtxosFilter,
): ExtendedVirtualCoin[] {
  return filter?.withUnrolled ? vtxos : vtxos.filter((v) => !v.isUnrolled)
}

/**
 * Wrap `wallet.getVtxos` with {@link withoutUnrolled}. Instance-level on
 * purpose: getBalance / settle / the SDK's backstop renew all read vtxos via
 * `this.getVtxos(...)`, so one boundary catches every consumer — bridge code
 * AND the SDK's own selection paths — without forking the SDK.
 */
export function installUnrolledVtxoFilter(wallet: {
  getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]>
}): void {
  const sdkGetVtxos = wallet.getVtxos.bind(wallet)
  wallet.getVtxos = async (filter?: GetVtxosFilter) =>
    withoutUnrolled(await sdkGetVtxos(filter), filter)
}

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
  installUnrolledVtxoFilter(wallet)

  const address = await wallet.getAddress()
  return { identity, wallet, address }
}
