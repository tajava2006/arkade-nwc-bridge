import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as defaults from './defaults'

export type { Network } from './defaults'

export interface Config {
  network: defaults.Network
  arkServerUrl: string
  boltzApiUrl: string
  esploraUrls: readonly string[]
  httpBind: string
  httpPort: number
  dbPath: string
}

// Optional file override — exists so a docker-compose deployment can point
// the bridge at an in-network ASP (or rebind off 127.0.0.1) without touching
// source, while a vanilla `bun run dev` clone keeps zero-config behavior
// because the file simply isn't there.
//
// Discovery: the cwd's data/config.json wins over the repo root's. A config
// file at the cwd is a deliberate setup — it's how the regtest drill runs an
// isolated runtime (up.sh writes runtime/data/config.json and starts the
// bridge from there). The repo-root anchor exists for the opposite case:
// an *accidental* cwd (running a file directly from elsewhere) must not
// stray outside the repo — but such a cwd has no config.json, so the
// fallback covers it.
const OVERRIDE_CANDIDATES = [
  resolve(process.cwd(), 'data', 'config.json'),
  resolve(defaults.REPO_ROOT, 'data', 'config.json'),
]

export function loadConfig(): Config {
  const { overrides, baseDir } = readOverrides()
  return {
    network: overrides.network ?? defaults.NETWORK,
    arkServerUrl: overrides.arkServerUrl ?? defaults.ARK_SERVER_URL,
    boltzApiUrl: overrides.boltzApiUrl ?? defaults.BOLTZ_API_URL,
    esploraUrls:
      overrides.esploraUrls && overrides.esploraUrls.length > 0
        ? overrides.esploraUrls
        : defaults.ESPLORA_URLS,
    httpBind: overrides.httpBind ?? defaults.HTTP_BIND,
    httpPort: overrides.httpPort ?? defaults.HTTP_PORT,
    // A relative override resolves against the loaded config's own base
    // (the directory holding its data/), so a config file means the same
    // thing no matter where the process started — the drill's sqlite lands
    // in ITS runtime, the repo config's in the repo.
    dbPath: overrides.dbPath ? resolve(baseDir, overrides.dbPath) : defaults.DB_PATH,
  }
}

function readOverrides(): { overrides: Partial<Config>; baseDir: string } {
  const path = OVERRIDE_CANDIDATES.find((p) => existsSync(p))
  if (!path) return { overrides: {}, baseDir: defaults.REPO_ROOT }
  const baseDir = dirname(dirname(path)) // <base>/data/config.json → <base>
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
    const keys = Object.keys(parsed)
    if (keys.length > 0) {
      console.log(`config: overrides from ${path}: ${keys.join(', ')}`)
    }
    return { overrides: parsed, baseDir }
  } catch (err) {
    console.warn(`config: failed to read ${path}: ${(err as Error).message}`)
    return { overrides: {}, baseDir }
  }
}
