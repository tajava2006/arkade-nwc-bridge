import {
  CSVMultisigTapscript,
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
  type OperatorInfo,
} from '@arkade-os/sdk'
import { hex } from '@scure/base'
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

// The largest checkpoint exit delay that a 24h setting can actually survive
// the wire as. arkd's default is 86400s (`defaultCheckpointExitDelay`, 24h)
// but the value reaches us inside a BIP-68 relative timelock, which encodes
// time in 512-second units: 86400 / 512 = 168.75, so the script carries 168
// units and decodes back as 86016s. SDK 0.4.62 started enforcing a mainnet
// floor of exactly 86400s against that decoded number, which no arkd running
// the stock 24h setting can ever clear — the SDK itself already met this on
// signet and hardcoded 86016 as that network's floor rather than fixing the
// comparison. We restate the floor at the same value: the largest multiple of
// 512 that is ≤ 24h.
//
// Deliberately a constant, NOT read from the server. The floor exists to
// reject an ASP that advertises a SHORTER exit delay than we're willing to
// accept (a short checkpoint delay shrinks the window to react during a
// unilateral exit); deriving it from what the server advertises would delete
// the check it is. 384 seconds below arkd's nominal 24h is the encoding's
// rounding, not a policy concession.
//
// Regtest is exempt: the drill's arkd runs deliberately short delays.
//
// SDK 0.5 dropped both its 86400s floor and the `minCheckpointExitDelaySeconds`
// option this constant used to feed — its own floor is now 512s. The floor is
// a bridge policy, so the bridge enforces it itself (assertCheckpointExitDelay,
// before the wallet is built); dropping it with the option would have quietly
// accepted any ASP.
export const MIN_CHECKPOINT_EXIT_DELAY_SECONDS = 86016n

/**
 * Throws (→ degraded boot, same message prefix the SDK used) when the ASP's
 * checkpoint exit delay is below our floor or not time-based. Mainnet-class
 * networks only.
 */
export function assertCheckpointExitDelay(info: Pick<OperatorInfo, 'checkpointTapscript'>): void {
  const { timelock } = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript)).params
  if (timelock.type !== 'seconds' || timelock.value < MIN_CHECKPOINT_EXIT_DELAY_SECONDS) {
    throw new Error(
      `checkpoint exit delay rejected: ${timelock.value} ${timelock.type} is below the ` +
        `${MIN_CHECKPOINT_EXIT_DELAY_SECONDS}s floor`,
    )
  }
}

export async function initArkWallet(cfg: Config, privateKey: Uint8Array): Promise<ArkContext> {
  const identity = SingleKey.fromPrivateKey(privateKey)

  // SDK 0.5 takes providers, not URLs (arkServerUrl / esploraUrl are gone).
  const operatorProvider = new RestOperatorProvider(cfg.arkServerUrl)
  if (cfg.network !== 'regtest') assertCheckpointExitDelay(await operatorProvider.getInfo())

  const wallet = await Wallet.create({
    identity,
    operatorProvider,
    // Pin the wallet's esplora to our own priority list instead of the
    // SDK's ASP-network-derived default (mempool.arkade.sh). The exit path
    // (src/exit/) reads chain state from the same list, so normal mode and
    // ASP-dead mode agree on what's confirmed — and a config.json override
    // (e.g. a self-hosted mempool) retargets both at once.
    onchainProvider: new EsploraProvider(cfg.esploraUrls[0]!),
    // The SDK's own indexer. The bridge used to substitute a whole-set reader
    // here because the 0.4 pager stopped after one arkd page (F23); 0.5 pages
    // on the server's own totals and sees every coin (regtest-checked with 155
    // coins and spent rows mixed in — test/regtest/sdk05_pager.test.ts).
    indexerProvider: new RestIndexerProvider(cfg.arkServerUrl),
    // Node has no IndexedDB; rebuild local caches from the indexer on each
    // boot. We have our own sqlite in src/db.ts for bridge-level state
    // (connections, payments, invoices) — that's a separate concern.
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    // BACKSTOP renewal only. The primary path is the bridge's own
    // consolidate-all auto-refresh (src/auto_refresh.ts, window 4d) —
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
