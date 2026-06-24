// Static defaults for the bridge. Edit here rather than threading an env
// file — there is no environment-specific knob worth a runtime override.
// The bridge is a personal, loopback-only service; relays and the ASP are
// effectively constants for the supported use case (mainnet zapping).

export type Network = 'bitcoin' | 'signet' | 'mutinynet' | 'regtest'

export const NETWORK: Network = 'bitcoin'

export const ARK_SERVER_URL = 'https://ark.hoppe-relay.it.com'

// Boltz API endpoint used for submarine / reverse swaps. Pinning our own
// instance instead of falling back to the SDK default keeps the swap path
// under operator control (uptime, fee policy, referral) and avoids the
// SDK's network-derived default flipping under us across version bumps.
export const BOLTZ_API_URL = 'https://boltz.hoppe-relay.it.com'

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
// Opaque offer id (noffer TLV 2). One spontaneous-price offer (payer names
// the amount). Not `zap`-prefixed yet: NIP-57 zap (handle the 9734 payload +
// publish the 9735 receipt on settlement) is a later phase — see offers.ts.
export const CLINK_OFFER_ID = 'default'

export const HTTP_BIND = '127.0.0.1'
export const HTTP_PORT = 4282

export const DB_PATH = './data/bridge.sqlite'
