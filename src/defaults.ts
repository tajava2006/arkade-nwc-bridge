import { join } from 'node:path'

// Static defaults for the bridge. Edit here rather than threading an env
// file — there is no environment-specific knob worth a runtime override.
// The bridge is a personal, loopback-only service; relays and the ASP are
// effectively constants for the supported use case (mainnet zapping).

// Repo root, anchored to this file's location (src/..) instead of the
// process cwd. `bun run <script>` cds to the package root, but running a
// file directly (`bun scripts/show-nsec.ts` from some other directory)
// keeps the caller's cwd — with cwd-relative paths that silently reads
// (or, on a fresh boot, *creates*) ./data somewhere outside the repo.
export const REPO_ROOT = join(import.meta.dir, '..')

export type Network = 'bitcoin' | 'signet' | 'mutinynet' | 'regtest'

export const NETWORK: Network = 'bitcoin'

export const ARK_SERVER_URL = 'https://ark.hoppe-relay.it.com'

// Boltz API endpoint used for submarine / reverse swaps. Pinning our own
// instance instead of falling back to the SDK default keeps the swap path
// under operator control (uptime, fee policy, referral) and avoids the
// SDK's network-derived default flipping under us across version bumps.
export const BOLTZ_API_URL = 'https://boltz.hoppe-relay.it.com'

// Well-known official Arkade (Ark Labs) mainnet ASP pair, offered as the
// non-default preset at /setup. NOT a fallback the bridge uses on its own — the
// fresh-start picker writes whichever pair the user chooses into bridge_server.
// The official Boltz has no custom sub-dust endpoints, so sub-dust / 21-sat
// swaps only work against the pair above; everything else (offboard, full
// drain, unilateral exit, ≥dust swaps) works against either, since those fees
// come from the connected server, not a constant.
export const OFFICIAL_ARK_SERVER_URL = 'https://arkade.computer'
export const OFFICIAL_BOLTZ_API_URL = 'https://api.boltz.exchange'

// Esplora endpoints, priority-ordered — the wallet's onchain view and the
// unilateral-exit path's only onchain dependency (EXIT_PLAN.md). Pinned here
// instead of letting the SDK derive its default from ASP info: the exit path
// exists for the ASP-dead case, so it can't inherit anything from getInfo,
// and the same URLs feed Wallet.create so normal-mode and exit-mode agree on
// chain state. mempool.space first — exit is the ASP-adversarial scenario, so
// infrastructure independent of the Ark ecosystem beats the SDK default
// (mempool.arkade.sh, Ark Labs operated). Both relay bitcoind submitpackage
// via POST /txs/package (probed 2026-07-04, EXIT_PLAN §7 #01) — a hard
// requirement: zero-fee pre-signed txs can only enter a mempool inside a
// 1P1C package. A self-hosted mempool instance slots in ahead of these via
// the data/config.json `esploraUrls` override.
export const ESPLORA_URLS: readonly string[] = [
  'https://mempool.space/api',
  'https://mempool.arkade.sh/api',
]

// Last-resort relay set, handed to new NWC connections only while
// *neither* the account key's nor the operator's NIP-65 list has
// resolved — e.g. all bootstrap relays unreachable at boot. Not used
// directly anywhere else; the bridge listens per-connection on whatever
// relays each connection's URI baked in at creation.
export const NWC_RELAYS_FALLBACK: readonly string[] = [
  'wss://relay.getalby.com/v1',
  'wss://relay.damus.io',
]

// Outbox-style relay discovery (NIP-65). Two-tier, both fetched via the
// bootstrap relays below:
//   - the account key's own kind-10002 (primary) — a standalone user
//     manages their relays from any nostr client; registered at runtime
//     via OutboxWatcher.setPrimaryPubkey once the account exists.
//   - OUTBOX_FALLBACK_PUBKEY's kind-10002 (this constant) — the
//     operator's curated list, the default until the user publishes
//     their own. If neither resolves within OUTBOX_INITIAL_TIMEOUT_MS,
//     NWC_RELAYS_FALLBACK stands in.
// Whatever wins becomes the active relay set for new NWC connection URIs
// and noffer minting (existing connections keep their baked-in relays).
//
// The pubkey below is the operator's general-purpose nostr identity;
// keeping the relay list there means changes propagate to the bridge
// without code edits. The bootstrap set is "well-known indexer relays"
// — any one of them succeeding is enough.
export const OUTBOX_FALLBACK_PUBKEY =
  '658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5'
export const OUTBOX_BOOTSTRAP_RELAYS: readonly string[] = [
  'wss://purplepag.es',
  'wss://nostr.land',
  'wss://nos.lol',
]
export const OUTBOX_INITIAL_TIMEOUT_MS = 10_000

// Consecutive failed proof-sync passes before the operator gets a
// health-asp DM (nostr/notifier.ts). With the capped 60s retry backoff,
// 5 ≈ a few minutes of continuous ASP/indexer unreachability — long enough
// to skip transient blips, short enough to matter.
export const EXIT_SYNC_ALERT_THRESHOLD = 5

// Defer the LOUD surfaces of a quarantine — the operator DM and the red
// dashboard/exit badges — until the flag has survived this long. A vtxo is
// quarantined the instant it disappears unexplained (exit safety net —
// immediate), but the disappearance is often transient: right after a
// settlement the indexer lags on serving the fresh spend PSBT / settledBy,
// and DURING a settle attempt the SDK masks the round's inputs from
// getVtxos entirely (observed mainnet 2026-08-01: a failing consolidate-all
// made a healthy vtxo flap in and out of quarantine). The next pass
// self-heals both (removeVtxo on late evidence / release on re-listing).
// 20 min = 2× the sync poll interval (DEFAULT_TIMING.pollIntervalMs =
// 10 min), so a lag that clears within one poll is gone before the alarm.
// Only the loud surfaces wait — the quarantine itself (and its exitability)
// is immediate, and in-grace flags still show muted ("verifying"). If the
// poll interval changes, revisit this. See sync_service.ts / vault.ts.
export const EXIT_QUARANTINE_DM_GRACE_MS = 20 * 60 * 1_000

// CLINK Offers (noffer) — the static, Nostr-native receive code shown on
// the dashboard. Served under the *account* key (same key the Ark wallet
// uses; its pubkey is already inside the displayed Ark address, so exposing
// it as the offer pubkey leaks nothing new and needs no extra backup).
//
// The noffer is minted from the operator's *current* outbox relay at mint
// time and the encoded string is persisted (clink_offer table) — we listen
// on the relay baked into that stored code, NOT the live outbox, which may
// have drifted since (mirrors connections.relays_json). A noffer carries
// only ONE relay (spec TLV 1 is singular), so we take outbox relay [0]; if
// that relay goes bad the operator regenerates by hand (dashboard shows its
// status). TODO(clink): noffer holds a single relay — push upstream to make
// TLV 1 a list so a static code can survive any one relay dying; until both
// ends support it, multi-relay on our side buys nothing.
//
// Opaque offer id (noffer TLV 2). One spontaneous-price offer (payer names the
// amount). `zap_`-prefixed per the CLINK spec (§NIP-57 Zaps) to signal that
// this offer accepts a NIP-57 zap payload — payer wallets seeing the prefix
// know they may include a kind-9734 in the `zap` field, which we commit into a
// descriptionHash invoice and answer on settlement with a kind-9735 receipt
// (see offers.ts / zap.ts). A request without a zap payload is still served as
// a plain spontaneous payment. Changing this constant invalidates any
// previously minted noffer (the id is baked into the code); startOfferService
// re-mints on boot when the stored code's id no longer matches.
export const CLINK_OFFER_ID = 'zap_default'

export const HTTP_BIND = '127.0.0.1'
export const HTTP_PORT = 4282

export const DB_PATH = join(REPO_ROOT, 'data', 'bridge.sqlite')
