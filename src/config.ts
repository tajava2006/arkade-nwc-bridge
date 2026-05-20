import { nip19 } from 'nostr-tools'

export type Network = 'bitcoin' | 'signet' | 'mutinynet' | 'regtest'

export interface Config {
  arkNsec: string
  arkPrivateKey: Uint8Array
  network: Network
  arkServerUrl: string
  nwcRelays: string[]
  httpBind: string
  httpPort: number
  dbPath: string
}

const NETWORKS: ReadonlySet<Network> = new Set(['bitcoin', 'signet', 'mutinynet', 'regtest'])

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(`missing required env var: ${name}`)
  }
  return value.trim()
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

function decodeNsec(nsec: string): Uint8Array {
  let decoded
  try {
    decoded = nip19.decode(nsec)
  } catch (e) {
    throw new Error(`ARK_NSEC is not a valid bech32 nsec string: ${(e as Error).message}`)
  }
  if (decoded.type !== 'nsec') {
    throw new Error(`ARK_NSEC must encode an nsec, got ${decoded.type}`)
  }
  return decoded.data
}

export function loadConfig(): Config {
  const arkNsec = requireEnv('ARK_NSEC')
  const arkPrivateKey = decodeNsec(arkNsec)

  const networkRaw = optionalEnv('NETWORK', 'bitcoin')
  if (!NETWORKS.has(networkRaw as Network)) {
    throw new Error(`NETWORK must be one of ${[...NETWORKS].join(', ')}, got '${networkRaw}'`)
  }
  const network = networkRaw as Network

  const nwcRelays = optionalEnv('NWC_RELAYS', '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
  if (nwcRelays.length === 0) {
    throw new Error('NWC_RELAYS must list at least one wss:// relay url')
  }
  for (const r of nwcRelays) {
    if (!r.startsWith('wss://') && !r.startsWith('ws://')) {
      throw new Error(`NWC_RELAYS entry '${r}' is not a ws(s):// url`)
    }
  }

  const httpPortRaw = optionalEnv('HTTP_PORT', '4282')
  const httpPort = Number.parseInt(httpPortRaw, 10)
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(`HTTP_PORT must be a valid port number, got '${httpPortRaw}'`)
  }

  return {
    arkNsec,
    arkPrivateKey,
    network,
    arkServerUrl: optionalEnv('ARK_SERVER_URL', 'https://arkade.computer'),
    nwcRelays,
    httpBind: optionalEnv('HTTP_BIND', '127.0.0.1'),
    httpPort,
    dbPath: optionalEnv('DB_PATH', './data/bridge.sqlite'),
  }
}
