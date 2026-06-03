import { existsSync, readFileSync } from 'node:fs'
import * as defaults from './defaults'

export type { Network } from './defaults'

export interface Config {
  network: defaults.Network
  arkServerUrl: string
  httpBind: string
  httpPort: number
  dbPath: string
}

// Optional file override — exists so a docker-compose deployment can point
// the bridge at an in-network ASP (or rebind off 127.0.0.1) without touching
// source, while a vanilla `bun run dev` clone keeps zero-config behavior
// because the file simply isn't there.
const OVERRIDE_PATH = './data/config.json'

export function loadConfig(): Config {
  const overrides = readOverrides()
  return {
    network: overrides.network ?? defaults.NETWORK,
    arkServerUrl: overrides.arkServerUrl ?? defaults.ARK_SERVER_URL,
    httpBind: overrides.httpBind ?? defaults.HTTP_BIND,
    httpPort: overrides.httpPort ?? defaults.HTTP_PORT,
    dbPath: overrides.dbPath ?? defaults.DB_PATH,
  }
}

function readOverrides(): Partial<Config> {
  if (!existsSync(OVERRIDE_PATH)) return {}
  try {
    const parsed = JSON.parse(readFileSync(OVERRIDE_PATH, 'utf8')) as Partial<Config>
    const keys = Object.keys(parsed)
    if (keys.length > 0) {
      console.log(`config: overrides from ${OVERRIDE_PATH}: ${keys.join(', ')}`)
    }
    return parsed
  } catch (err) {
    console.warn(`config: failed to read ${OVERRIDE_PATH}: ${(err as Error).message}`)
    return {}
  }
}
