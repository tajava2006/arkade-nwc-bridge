import type { SimplePool } from 'nostr-tools/pool'
import { normalizeURL } from 'nostr-tools/utils'

// Why this exists: every reconnect path in the bridge used to retry on a
// fixed 5s timer with no memory of earlier failures — one timer per
// persistent sub plus the index.ts watchdog. Against a relay that refuses
// the handshake outright that measured ~120 fresh sockets a minute
// (~175k/day), forever. That is spam, and it got the operating IP
// blocked by nos.lol / nostr.mom / relay.damus.io (2026-10).
//
// The gate is the single place that decides "may a NEW socket to this
// relay be opened right now?". It is installed as the pool's
// allowConnectingToRelay hook (covers every subscribe and publish) and
// the direct ensureRelay callers go through ensure(). Callers that
// arrive while an attempt is already in flight are let through — they
// join that attempt's promise inside nostr-tools and open nothing.

const BASE_DELAY_MS = 5_000
const MAX_DELAY_MS = 5 * 60_000
const JITTER = 0.2
// Same budget the pool gives its own subscribe/publish connects.
const CONNECT_TIMEOUT_MS = 3_000
// A connection has to survive this long before its relay is trusted
// again. Without it a relay that accepts the socket and drops it a
// second later ("connect, then kick" — how some relays rate-limit)
// would reset the count on every cycle and be retried at full speed.
const STABLE_AFTER_MS = 60_000

export interface RelayGateOptions {
  pool: SimplePool
  /** Test hooks — production callers leave all of these alone. */
  baseDelayMs?: number
  maxDelayMs?: number
  stableAfterMs?: number
  now?: () => number
  random?: () => number
  log?: (line: string) => void
}

export interface RelayGate {
  /** May a caller open (or join) a connection to this relay now? */
  allow(url: string): boolean
  /** A connect attempt failed. Idempotent across joiners of one attempt. */
  failed(url: string): void
  /** A connect attempt succeeded. */
  succeeded(url: string): void
  /**
   * Gated pool.ensureRelay for callers that want a socket without a
   * subscription. Resolves false when the relay is backing off (no
   * attempt made) or the attempt failed — never rejects.
   */
  ensure(url: string): Promise<boolean>
  /** Ms until the next attempt is allowed; 0 when not backing off. */
  retryInMs(url: string): number
}

interface RelayState {
  failures: number
  blockedUntil: number
  /** When the current (or just-lost) connection came up; null if none. */
  upSince: number | null
}

export function createRelayGate(opts: RelayGateOptions): RelayGate {
  const { pool } = opts
  const now = opts.now ?? Date.now
  const random = opts.random ?? Math.random
  const log = opts.log ?? ((line: string) => console.warn(line))
  const baseDelayMs = opts.baseDelayMs ?? BASE_DELAY_MS
  const maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_MS
  const stableAfterMs = opts.stableAfterMs ?? STABLE_AFTER_MS
  const states = new Map<string, RelayState>()

  const stateOf = (url: string): RelayState => {
    let s = states.get(url)
    if (!s) {
      s = { failures: 0, blockedUntil: 0, upSince: null }
      states.set(url, s)
    }
    return s
  }

  const penalize = (url: string, s: RelayState, why: string): void => {
    s.failures++
    const exp = Math.min(baseDelayMs * 2 ** (s.failures - 1), maxDelayMs)
    const delay = Math.round(exp * (1 + JITTER * (2 * random() - 1)))
    s.blockedUntil = now() + delay
    log(
      `nostr: relay ${url} ${why} (failure #${s.failures}) — next attempt in ${Math.round(delay / 1000)}s`,
    )
  }

  const isConnected = (url: string): boolean => pool.listConnectionStatus().get(url) === true

  const allow = (rawUrl: string): boolean => {
    const url = normalize(rawUrl)
    const s = stateOf(url)
    const t = now()
    if (isConnected(url)) {
      // Publishes don't report success, so the gate may learn about a
      // live socket here first.
      s.upSince ??= t
      if (s.failures > 0 && t - s.upSince >= stableAfterMs) s.failures = 0
      return true
    }
    if (s.upSince !== null) {
      // First look since the socket went away.
      const lived = t - s.upSince
      s.upSince = null
      if (lived >= stableAfterMs) {
        s.failures = 0
        s.blockedUntil = 0
      } else {
        penalize(url, s, `dropped us after ${Math.round(lived / 1000)}s`)
      }
    }
    return t >= s.blockedUntil
  }

  const failed = (rawUrl: string): void => {
    const url = normalize(rawUrl)
    const s = stateOf(url)
    s.upSince = null
    // Everyone who joined the failed attempt reports it; count it once.
    if (s.blockedUntil > now()) return
    penalize(url, s, 'unreachable')
  }

  const succeeded = (rawUrl: string): void => {
    const s = stateOf(normalize(rawUrl))
    s.upSince ??= now()
  }

  return {
    allow,
    failed,
    succeeded,
    async ensure(rawUrl) {
      const url = normalize(rawUrl)
      if (!allow(url)) return false
      try {
        // The timeout is not optional. nostr-tools shares one connection
        // promise per relay and only the caller that created it gets to
        // set a timeout; without one here, a relay that swallows the SYN
        // leaves a promise that hangs for minutes, and every publish and
        // subscribe that joins it hangs too (their own 3s is ignored).
        await pool.ensureRelay(url, { connectionTimeout: CONNECT_TIMEOUT_MS })
        succeeded(url)
        return true
      } catch {
        failed(url)
        return false
      }
    },
    retryInMs(rawUrl) {
      const s = states.get(normalize(rawUrl))
      if (!s) return 0
      return Math.max(0, s.blockedUntil - now())
    },
  }
}

// The pool's own canonical form — its status map and hook arguments are
// keyed by it, and it differs from WHATWG on trailing-slash paths.
function normalize(url: string): string {
  try {
    return normalizeURL(url)
  } catch {
    return url
  }
}
