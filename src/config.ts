import * as defaults from './defaults'

export type { Network } from './defaults'

export interface Config {
  network: defaults.Network
  arkServerUrl: string
  nwcRelays: string[]
  httpBind: string
  httpPort: number
  dbPath: string
}

export function loadConfig(): Config {
  return {
    network: defaults.NETWORK,
    arkServerUrl: defaults.ARK_SERVER_URL,
    nwcRelays: [...defaults.NWC_RELAYS],
    httpBind: defaults.HTTP_BIND,
    httpPort: defaults.HTTP_PORT,
    dbPath: defaults.DB_PATH,
  }
}
