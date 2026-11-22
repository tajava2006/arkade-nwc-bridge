import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as defaults from './defaults'
import { parseLightningConfig, type LightningConfig } from './lightning_config'

export type { Network } from './defaults'

export interface Config {
  network: defaults.Network
  arkServerUrl: string
  esploraUrls: readonly string[]
  /** Solver + subdustd + emulator key (data/config.json only); undefined = Ark-only. */
  lightning?: LightningConfig
  /**
   * Replace the public bootstrap + fallback relay lists with these (a private
   * relay deployment, or regtest). The bridge then opens no other relay.
   * Unset = the static defaults in defaults.ts.
   */
  nostrRelays?: readonly string[]
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
    esploraUrls:
      overrides.esploraUrls && overrides.esploraUrls.length > 0
        ? overrides.esploraUrls
        : defaults.ESPLORA_URLS,
    // Throws on a malformed block — boot must not guess at payment endpoints.
    lightning: parseLightningConfig((overrides as { lightning?: unknown }).lightning, baseDir),
    nostrRelays: overrides.nostrRelays && overrides.nostrRelays.length > 0 ? overrides.nostrRelays : undefined,
    httpBind: overrides.httpBind ?? defaults.HTTP_BIND,
    httpPort: overrides.httpPort ?? defaults.HTTP_PORT,
    // A relative override resolves against the loaded config's own base
    // (the directory holding its data/), so a config file means the same
    // thing no matter where the process started — the drill's sqlite lands
    // in ITS runtime, the repo config's in the repo.
    dbPath: overrides.dbPath ? resolve(baseDir, overrides.dbPath) : defaults.DB_PATH,
  }
}

/**
 * The Ark server set by data/config.json only (undefined when the file is
 * absent or doesn't pin it). Kept separate from loadConfig so
 * resolveServerSet (src/server_config.ts) can layer it over the fresh-start
 * row: config.json > row > defaults.ts.
 */
export function readServerOverrides(): { arkServerUrl?: string } {
  const { overrides } = readOverrides()
  return { arkServerUrl: overrides.arkServerUrl }
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
