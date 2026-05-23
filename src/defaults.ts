// Static defaults for the bridge. Edit here rather than threading an env
// file — there is no environment-specific knob worth a runtime override.
// The bridge is a personal, loopback-only service; relays and the ASP are
// effectively constants for the supported use case (mainnet zapping).

export type Network = 'bitcoin' | 'signet' | 'mutinynet' | 'regtest'

export const NETWORK: Network = 'bitcoin'

export const ARK_SERVER_URL = 'https://arkade.computer'

export const NWC_RELAYS: readonly string[] = [
  'wss://relay.getalby.com/v1',
  'wss://relay.damus.io',
]

export const HTTP_BIND = '127.0.0.1'
export const HTTP_PORT = 4282

export const DB_PATH = './data/bridge.sqlite'
