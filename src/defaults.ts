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

// Fallback relay set handed to new NWC connections when the outbox
// watcher can't resolve the operator's NIP-65 list — e.g. all bootstrap
// relays unreachable at boot, or the pubkey hasn't published 10002 yet.
// Not used directly anywhere else; the bridge listens per-connection on
// whatever relays each connection's URI baked in at creation.
export const NWC_RELAYS_FALLBACK: readonly string[] = [
  'wss://relay.getalby.com/v1',
  'wss://relay.damus.io',
]

// Outbox-style relay discovery (NIP-65). At boot the bridge subscribes
// to this pubkey's kind-10002 events via the bootstrap relays below;
// whatever it lists becomes the active relay set for NWC subscriptions
// and new connection URIs, replacing NWC_RELAYS. If no 10002 arrives
// within OUTBOX_INITIAL_TIMEOUT_MS — bootstrap relays all down, or the
// pubkey hasn't published recently — NWC_RELAYS stays as the fallback.
//
// The pubkey below is the operator's general-purpose nostr identity;
// keeping the relay list there means changes propagate to the bridge
// without code edits. The bootstrap set is "well-known indexer relays"
// — any one of them succeeding is enough.
export const OUTBOX_DISCOVERY_PUBKEY =
  '658988350649280e43ebcdf83c20dd21273aeb4eeaa8eda7864b0fa9b57cb7a5'
export const OUTBOX_BOOTSTRAP_RELAYS: readonly string[] = [
  'wss://purplepag.es',
  'wss://nostr.land',
  'wss://relay.nostr.pub',
  'wss://relay.nostr.band',
  'wss://nos.lol',
]
export const OUTBOX_INITIAL_TIMEOUT_MS = 10_000

export const HTTP_BIND = '127.0.0.1'
export const HTTP_PORT = 4282

export const DB_PATH = './data/bridge.sqlite'
