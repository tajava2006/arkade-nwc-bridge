import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Where the bridge's Lightning rails live: the operator's own intent-solver
// (dust and up) and subdustd (sub-dust), plus the operator's own emulator key.
// Operator infrastructure, so it comes from data/config.json (`lightning`), not
// the /setup form. Absent ⇒ the bridge runs Ark-only and the LN rails refuse.
//
// Strict on purpose: a typo here would either pin a foreign emulator key —
// the refund path would then hang on a third party — or point payments at a
// solver nobody chose. A malformed block refuses boot instead.

export interface SolverCard {
  discovery_pubkey: string
  markets: unknown[]
  [key: string]: unknown
}

export interface LightningConfig {
  /** Our intent-solver's HTTP endpoint (private network). */
  solverUrl: string
  /** Its signed card (`cli card` output) — the only market the client trusts. */
  solverCard: SolverCard
  /** subdustd's API base; its push channel is `${subdustdUrl}/v2/ws`. */
  subdustdUrl: string
  /** Our emulator's compressed pubkey; replaces the SDK's Ark Labs default. */
  emulatorPubkey: string
}

export class LightningConfigError extends Error {}

const isHttpUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\/[^/\s]+/.test(v)

/**
 * `raw` is the config.json `lightning` value; `baseDir` anchors a relative
 * `solverCardPath`. Returns undefined when the block is absent.
 */
export function parseLightningConfig(raw: unknown, baseDir: string): LightningConfig | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new LightningConfigError('lightning: expected an object')
  const o = raw as Record<string, unknown>
  const allowed = ['solverUrl', 'solverCard', 'solverCardPath', 'subdustdUrl', 'emulatorPubkey']
  const problems: string[] = []
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`lightning.${k}: unknown key`)
  if (!isHttpUrl(o.solverUrl)) problems.push('lightning.solverUrl: required http(s) URL')
  if (!isHttpUrl(o.subdustdUrl)) problems.push('lightning.subdustdUrl: required http(s) URL')
  if (typeof o.emulatorPubkey !== 'string' || !/^0[23][0-9a-f]{64}$/.test(o.emulatorPubkey)) {
    problems.push('lightning.emulatorPubkey: required 33-byte compressed hex key')
  }

  let card: unknown = o.solverCard
  if (card === undefined && typeof o.solverCardPath === 'string') {
    try {
      card = JSON.parse(readFileSync(resolve(baseDir, o.solverCardPath), 'utf8'))
    } catch (e) {
      problems.push(`lightning.solverCardPath: ${(e as Error).message}`)
    }
  } else if (card !== undefined && o.solverCardPath !== undefined) {
    problems.push('lightning: give solverCard or solverCardPath, not both')
  }
  const c = card as Partial<SolverCard> | undefined
  if (!c || typeof c !== 'object' || typeof c.discovery_pubkey !== 'string' || !Array.isArray(c.markets) || c.markets.length === 0) {
    if (!problems.some((p) => p.startsWith('lightning.solverCardPath'))) {
      problems.push('lightning.solverCard: required solver card (discovery_pubkey + markets)')
    }
  }
  if (problems.length > 0) throw new LightningConfigError(`lightning config rejected:\n  - ${problems.join('\n  - ')}`)

  return {
    solverUrl: (o.solverUrl as string).replace(/\/+$/, ''),
    solverCard: c as SolverCard,
    subdustdUrl: (o.subdustdUrl as string).replace(/\/+$/, ''),
    emulatorPubkey: o.emulatorPubkey as string,
  }
}
