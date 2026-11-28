import type { Database } from 'bun:sqlite'
import { RestArkProvider } from '@arkade-os/sdk'
import * as defaults from './defaults'
import type { Network } from './defaults'
import { readServerOverrides } from './config'

// bridge_server (migration v4): the Ark server (arkd) chosen once at the first
// /setup and then frozen. There is no multi-server wallet; changing servers
// means draining funds and starting over from a fresh sqlite. Exactly one row
// (id=1), CRUD mirrors src/exit/dest.ts. The row's boltz_url column is a
// leftover of the Boltz era (NOT NULL, migrations are append-only): written
// empty, never read. Lightning lives in data/config.json (`lightning`).
//
// The value actually used at runtime is resolveServerSet(), which layers the
// row under the data/config.json override: data/config.json > row > defaults.ts.
// network/esplora are NOT stored here.

export interface ServerSet {
  arkServerUrl: string
}

interface Row {
  ark_url: string
}

/** The fresh-start row, or null before the first /setup writes it. */
export function getServerRow(db: Database): ServerSet | null {
  const row = db
    .query<Row, []>('SELECT ark_url FROM bridge_server WHERE id = 1')
    .get()
  return row ? { arkServerUrl: row.ark_url } : null
}

/** Write the single row (id=1). Upsert so a grandfather backfill is idempotent. */
export function setServerRow(db: Database, set: ServerSet): void {
  db.query(
    `INSERT INTO bridge_server (id, ark_url, boltz_url, created_at)
     VALUES (1, ?, '', ?)
     ON CONFLICT(id) DO UPDATE SET
       ark_url = excluded.ark_url, boltz_url = '', created_at = excluded.created_at`,
  ).run(set.arkServerUrl, Math.floor(Date.now() / 1000))
}

/** Remove the row — the rollback half of a failed /setup (with the account). */
export function clearServerRow(db: Database): void {
  db.query('DELETE FROM bridge_server WHERE id = 1').run()
}

/**
 * The effective Ark server for this process. Precedence: data/config.json >
 * bridge_server row > defaults.ts. A data/config.json that pins the URL (the
 * docker / regtest override) still wins over the fresh-start row; a
 * disagreement is logged rather than hidden. The override is a parameter so
 * the precedence is unit-testable without a file.
 */
export function resolveServerSet(db: Database, override = readServerOverrides()): ServerSet {
  const row = getServerRow(db)
  if (row && override.arkServerUrl && override.arkServerUrl !== row.arkServerUrl) {
    console.warn(
      `server: data/config.json arkServerUrl (${override.arkServerUrl}) overrides the ` +
        `fresh-start row (${row.arkServerUrl})`,
    )
  }
  return { arkServerUrl: override.arkServerUrl ?? row?.arkServerUrl ?? defaults.ARK_SERVER_URL }
}

export type ValidateResult = { ok: true } | { ok: false; reason: string }

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Validate a server set *before* the choice is committed. Because the choice is
 * immutable (change = drain + fresh sqlite), a bad URL here would brick the
 * install, so we fail loudly at /setup instead of at first use.
 *
 * The load-bearing check is the network assert: a wrong-network arkd can look
 * "connected" and silently hand back addresses on a chain the operator's funds
 * will never reach — the exact way to lose money quietly. arkd's getInfo
 * carries the network (same field src/atomic_*.ts read as `info.network`).
 */
export async function validateServerSet(set: ServerSet, network: Network): Promise<ValidateResult> {
  let arkNetwork: string
  try {
    const info = await withTimeout(
      new RestArkProvider(set.arkServerUrl).getInfo(),
      10_000,
      'Ark server getInfo',
    )
    arkNetwork = info.network
  } catch (err) {
    return { ok: false, reason: `Ark server unreachable at ${set.arkServerUrl}: ${errMsg(err)}` }
  }
  if (arkNetwork !== network) {
    return {
      ok: false,
      reason:
        `Ark server reports network '${arkNetwork}', but this bridge runs '${network}'. ` +
        `Point it at a '${network}' Ark server (or reset the bridge's network in defaults.ts).`,
    }
  }

  return { ok: true }
}
