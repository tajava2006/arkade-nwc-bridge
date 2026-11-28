// Where the bridge's Lightning rail lives: the operator's own subdustd, which
// carries every amount both ways (D11). Operator infrastructure, so it comes
// from data/config.json (`lightning`), not the /setup form. Absent ⇒ the bridge
// runs Ark-only and the LN methods refuse.
//
// Strict on purpose: a typo here would point payments somewhere nobody chose,
// so a malformed block refuses boot instead.

export interface LightningConfig {
  /** subdustd's API base; its push channel is `${subdustdUrl}/v2/ws`. */
  subdustdUrl: string
}

export class LightningConfigError extends Error {}

const isHttpUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\/[^/\s]+/.test(v)

/** The solver-era keys (D11 removed the solver and the emulator) — named so the refusal says why. */
const RETIRED = ['solverUrl', 'solverCard', 'solverCardPath', 'emulatorPubkey']

/** `raw` is the config.json `lightning` value. Returns undefined when the block is absent. */
export function parseLightningConfig(raw: unknown): LightningConfig | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new LightningConfigError('lightning: expected an object')
  const o = raw as Record<string, unknown>
  const problems: string[] = []
  for (const k of Object.keys(o)) {
    if (RETIRED.includes(k)) problems.push(`lightning.${k}: no longer used — subdustd carries every amount now; remove it`)
    else if (k !== 'subdustdUrl') problems.push(`lightning.${k}: unknown key`)
  }
  if (!isHttpUrl(o.subdustdUrl)) problems.push('lightning.subdustdUrl: required http(s) URL')
  if (problems.length > 0) throw new LightningConfigError(`lightning config rejected:\n  - ${problems.join('\n  - ')}`)
  return { subdustdUrl: (o.subdustdUrl as string).replace(/\/+$/, '') }
}
