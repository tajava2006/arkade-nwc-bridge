import { accessSync, constants, readFileSync } from 'node:fs'

// One JSON file, no env vars (same rule as the bridge). Strict on purpose: a
// misspelled knob would otherwise fall back to its default without a word, and
// these knobs set refund locktimes and LN cltv budgets on mainnet money.

export const NETWORKS = ['bitcoin', 'testnet', 'signet', 'mutinynet', 'regtest'] as const
export type Network = (typeof NETWORKS)[number]

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface SubdustKnobs {
  sendWindowSecs: number
  receiveWindowSecs: number
  payMarginSecs: number
  blockTimeSecs: number
  sendFeePercent: number
}

export interface SubdustdConfig {
  network: Network
  arkdUrl: string
  lnd: { socket: string; certPath: string; macaroonPath: string }
  keyPath: string
  dbPath: string
  http: { host: string; port: number }
  logLevel: LogLevel
  subdust: SubdustKnobs
}

// The live mainnet values carried over from boltz.conf `[ark]` (my-server
// SETTINGS.md), so a deployment that omits a knob gets the tuned value, not the
// fork's old 1800s default that left every multi-hop route NO_ROUTE.
export const DEFAULT_KNOBS: SubdustKnobs = {
  sendWindowSecs: 324_000,
  receiveWindowSecs: 21_600,
  payMarginSecs: 600,
  blockTimeSecs: 600,
  sendFeePercent: 0.5,
}

export const DEFAULT_HTTP = { host: '127.0.0.1', port: 9010 }

// Phoenix-style receivers want a 144-block final delta behind 144 blocks of
// channel deltas; a send budget under that is NO_ROUTE by construction.
const MAINNET_MIN_SEND_CLTV_BLOCKS = 288

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`subdustd config rejected:\n  - ${problems.join('\n  - ')}`)
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

class Reader {
  readonly problems: string[] = []

  object(v: unknown, at: string, allowed: readonly string[]): Obj {
    if (!isObj(v)) {
      this.problems.push(`${at}: expected an object`)
      return {}
    }
    for (const k of Object.keys(v)) {
      if (!allowed.includes(k)) this.problems.push(`${at}.${k}: unknown key`)
    }
    return v
  }

  string(o: Obj, key: string, at: string, fallback?: string): string {
    const v = o[key]
    if (v === undefined && fallback !== undefined) return fallback
    if (typeof v !== 'string' || v.trim() === '') {
      this.problems.push(`${at}.${key}: required non-empty string`)
      return ''
    }
    return v
  }

  oneOf<T extends string>(o: Obj, key: string, at: string, options: readonly T[], fallback?: T): T {
    const v = o[key]
    if (v === undefined && fallback !== undefined) return fallback
    if (typeof v !== 'string' || !options.includes(v as T)) {
      this.problems.push(`${at}.${key}: must be one of ${options.join(' | ')}`)
      return options[0]!
    }
    return v as T
  }

  number(o: Obj, key: string, at: string, fallback: number, opts: { integer: boolean; min: number }): number {
    const v = o[key]
    if (v === undefined) return fallback
    if (typeof v !== 'number' || !Number.isFinite(v) || (opts.integer && !Number.isInteger(v)) || v < opts.min) {
      this.problems.push(`${at}.${key}: must be ${opts.integer ? 'an integer' : 'a number'} >= ${opts.min}`)
      return fallback
    }
    return v
  }
}

const parseSocket = (socket: string): string | undefined => {
  const m = /^(.+):(\d{1,5})$/.exec(socket)
  if (!m) return 'must be host:port'
  const port = Number(m[2])
  return port >= 1 && port <= 65535 ? undefined : 'port out of range'
}

/** Pure: validates shape and the knob inequalities. File presence is `checkConfigFiles`. */
export const parseConfig = (raw: unknown): { config: SubdustdConfig; warnings: string[] } => {
  const r = new Reader()
  const root = r.object(raw, 'config', ['network', 'arkdUrl', 'lnd', 'keyPath', 'dbPath', 'http', 'logLevel', 'subdust'])

  const network = r.oneOf(root, 'network', 'config', NETWORKS)
  const arkdUrl = r.string(root, 'arkdUrl', 'config')
  if (arkdUrl && !/^https?:\/\/[^/]/.test(arkdUrl)) r.problems.push('config.arkdUrl: must be an http(s) URL')

  const lndRaw = r.object(root.lnd, 'config.lnd', ['socket', 'certPath', 'macaroonPath'])
  const lnd = {
    socket: r.string(lndRaw, 'socket', 'config.lnd'),
    certPath: r.string(lndRaw, 'certPath', 'config.lnd'),
    macaroonPath: r.string(lndRaw, 'macaroonPath', 'config.lnd'),
  }
  const socketProblem = lnd.socket ? parseSocket(lnd.socket) : undefined
  if (socketProblem) r.problems.push(`config.lnd.socket: ${socketProblem}`)

  const httpRaw = root.http === undefined ? {} : r.object(root.http, 'config.http', ['host', 'port'])
  const http = {
    host: r.string(httpRaw, 'host', 'config.http', DEFAULT_HTTP.host),
    port: r.number(httpRaw, 'port', 'config.http', DEFAULT_HTTP.port, { integer: true, min: 1 }),
  }
  if (http.port > 65535) r.problems.push('config.http.port: out of range')

  const knobsRaw =
    root.subdust === undefined ? {} : r.object(root.subdust, 'config.subdust', Object.keys(DEFAULT_KNOBS))
  const knob = (key: keyof SubdustKnobs, integer = true, min = 1) =>
    r.number(knobsRaw, key, 'config.subdust', DEFAULT_KNOBS[key], { integer, min })
  const subdust: SubdustKnobs = {
    sendWindowSecs: knob('sendWindowSecs'),
    receiveWindowSecs: knob('receiveWindowSecs'),
    payMarginSecs: knob('payMarginSecs'),
    blockTimeSecs: knob('blockTimeSecs'),
    sendFeePercent: knob('sendFeePercent', false, 0),
  }
  // Send pays with cltvLimit = (T − payMargin) / blockTime; at or past the
  // window there is no budget left and every send fails. Receive uses the
  // margin only as funding headroom, so it may exceed the receive window.
  if (subdust.payMarginSecs >= subdust.sendWindowSecs) {
    r.problems.push('config.subdust: payMarginSecs must be < sendWindowSecs (no LN cltv budget left)')
  }
  if (subdust.sendFeePercent >= 100) r.problems.push('config.subdust.sendFeePercent: must be < 100')

  const config: SubdustdConfig = {
    network,
    arkdUrl,
    lnd,
    keyPath: r.string(root, 'keyPath', 'config'),
    dbPath: r.string(root, 'dbPath', 'config'),
    http,
    logLevel: r.oneOf(root, 'logLevel', 'config', LOG_LEVELS, 'info'),
    subdust,
  }
  if (r.problems.length > 0) throw new ConfigError(r.problems)

  const warnings: string[] = []
  if (network === 'bitcoin') {
    const budget = Math.floor((subdust.sendWindowSecs - subdust.payMarginSecs) / subdust.blockTimeSecs)
    if (budget < MAINNET_MIN_SEND_CLTV_BLOCKS) {
      warnings.push(`send cltv budget ${budget} blocks < ${MAINNET_MIN_SEND_CLTV_BLOCKS}: long routes will be NO_ROUTE`)
    }
    if (subdust.sendFeePercent === 0) {
      warnings.push('sendFeePercent 0 on mainnet: we front the LN routing fee for free (griefing vector)')
    }
  }
  return { config, warnings }
}

/** Mount mistakes surface at boot, not on the first swap. */
export const checkConfigFiles = (config: SubdustdConfig): void => {
  const problems: string[] = []
  const readable: [string, string][] = [
    ['lnd.certPath', config.lnd.certPath],
    ['lnd.macaroonPath', config.lnd.macaroonPath],
    ['keyPath', config.keyPath],
  ]
  for (const [name, path] of readable) {
    try {
      accessSync(path, constants.R_OK)
    } catch {
      problems.push(`config.${name}: ${path} is not readable`)
    }
  }
  if (problems.length > 0) throw new ConfigError(problems)
}

export const loadConfig = (path: string): { config: SubdustdConfig; warnings: string[] } => {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new ConfigError([`${path}: ${e instanceof Error ? e.message : String(e)}`])
  }
  return parseConfig(raw)
}
