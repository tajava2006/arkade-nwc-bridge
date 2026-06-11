import type { SimplePool } from 'nostr-tools/pool'
import type { NostrEvent } from 'nostr-tools/pure'

import type { RelayStatus } from '../lib/relay_status'
import { openPersistentSub } from './persistent_sub'

// NIP-65 "relay list metadata" — replaceable, one per author. The 'r'
// tags carry relay URLs, optionally suffixed with "read" / "write"
// markers. We treat any 'r' as authoritative regardless of marker: the
// goal here is "which relays does this operator currently publish to"
// for NWC defaults, and NWC clients and the bridge talk in both
// directions on the same set so the read/write asymmetry doesn't apply.
const OUTBOX_KIND = 10002

export interface OutboxConfig {
  /**
   * Shared SimplePool. The watcher subscribes on bootstrap relays via
   * this pool and ensures connections to current outbox relays through
   * it — same pool the nostr service uses for per-connection subs, so
   * listConnectionStatus is the single source of truth for relay
   * health across the whole bridge.
   */
  pool: SimplePool
  pubkey: string
  bootstrapRelays: readonly string[]
  /**
   * Returned by getOutboxRelays() before any 10002 arrives, or if no
   * event ever lands. Also the source of new-connection URIs while the
   * watcher is unresolved, so the bridge stays usable even with all
   * bootstrap relays down.
   */
  fallback: readonly string[]
  /**
   * Boot-time grace period. startOutboxWatcher resolves after the first
   * 10002 lands OR this elapses, whichever first. The watcher keeps
   * running either way — late-arriving updates still fire onOutboxChange.
   */
  initialTimeoutMs?: number
}

export interface OutboxWatcher {
  /** Most recent outbox relay list, or fallback if no 10002 has arrived. */
  getOutboxRelays(): string[]
  /** True once a non-empty 10002 has been processed. */
  isResolved(): boolean
  /** Live connection state of the bootstrap relays this watcher uses. */
  getBootstrapRelayStatus(): RelayStatus[]
  /** Live connection state of the current outbox relays. */
  getOutboxRelayStatus(): RelayStatus[]
  /** Fires on each *change* to the outbox set (not on every 10002 event). */
  onOutboxChange(fn: (relays: string[]) => void): () => void
  /** Closes the bootstrap subscription. Does not close the shared pool. */
  stop(): Promise<void>
}

export async function startOutboxWatcher(cfg: OutboxConfig): Promise<OutboxWatcher> {
  const timeoutMs = cfg.initialTimeoutMs ?? 10_000
  // Normalize so URLs we store/compare match what the pool reports
  // back (post-WHATWG URL, e.g. trailing slash added). Without this,
  // any `bootstrap.includes(url)` comparison would always miss.
  const bootstrap = cfg.bootstrapRelays.map(normalizeRelayUrl)
  const fallback = cfg.fallback.map(normalizeRelayUrl)
  const pool = cfg.pool

  let outboxRelays: string[] = [...fallback]
  let lastCreatedAt = 0
  let resolved = false
  const outboxListeners = new Set<(relays: string[]) => void>()

  let firstResolve: (() => void) | null = null
  const firstEvent = new Promise<void>((r) => {
    firstResolve = r
  })

  const ensureConnections = (urls: readonly string[]): void => {
    // Open a connection per relay without subscribing — purely for
    // status visibility. ensureRelay throws on bad URLs; swallow per
    // relay so one malformed entry doesn't poison the whole set.
    for (const url of urls) {
      pool.ensureRelay(url).catch((err) => {
        console.warn(`outbox: ensureRelay(${url}) failed:`, err)
      })
    }
  }

  const handle = (event: NostrEvent): void => {
    if (event.pubkey !== cfg.pubkey || event.kind !== OUTBOX_KIND) return
    if (event.created_at <= lastCreatedAt) return
    const relays = extractRelays(event).map(normalizeRelayUrl)
    if (relays.length === 0) {
      // An empty 10002 means "I publish nowhere right now" — useless
      // as a default. Record the timestamp so we don't re-process,
      // but keep whatever we had.
      lastCreatedAt = event.created_at
      return
    }
    lastCreatedAt = event.created_at
    const changed = !sameSet(outboxRelays, relays)
    outboxRelays = relays
    resolved = true
    if (firstResolve) {
      firstResolve()
      firstResolve = null
    }
    ensureConnections(relays)
    if (changed) {
      for (const l of outboxListeners) {
        try {
          l([...relays])
        } catch (err) {
          console.error('outbox: change listener crashed:', err)
        }
      }
    }
  }

  // Pre-warm bootstrap and fallback. subscribeMany on bootstrap will
  // also ensureRelay, but doing it explicitly keeps the intent clear
  // (and seeds status before subscribeMany finishes its handshake).
  ensureConnections(bootstrap)
  ensureConnections(fallback)

  // PersistentSub so a bootstrap relay that nostr-tools gives up on
  // (failed reconnect → subscriptions permanently closed) gets its
  // 10002 sub re-issued once the socket is back. No resumeSince: on
  // re-attach we want the latest stored replaceable event regardless
  // of age — handle() dedupes by created_at.
  const sub = openPersistentSub({
    pool,
    relays: bootstrap,
    label: 'outbox',
    filter: {
      kinds: [OUTBOX_KIND],
      authors: [cfg.pubkey],
      // Replaceable-event semantics: limit:1 asks the relay for the
      // single latest matching event. The subscription itself stays
      // open after EOSE — future 10002 updates from this pubkey will
      // still be streamed live, which is exactly what we want.
      limit: 1,
    },
    onevent: handle,
  })

  await Promise.race([
    firstEvent,
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ])

  return {
    getOutboxRelays: () => [...outboxRelays],
    isResolved: () => resolved,
    getBootstrapRelayStatus: () => snapshot(pool, bootstrap),
    getOutboxRelayStatus: () => snapshot(pool, outboxRelays),
    onOutboxChange(fn) {
      outboxListeners.add(fn)
      return () => {
        outboxListeners.delete(fn)
      }
    },
    async stop() {
      sub.close()
      // Pool is owned by the caller (index.ts) — they close it after
      // every subsystem has stopped.
    },
  }
}

function snapshot(pool: SimplePool, urls: readonly string[]): RelayStatus[] {
  const live = pool.listConnectionStatus()
  return urls.map((url) => ({ url, connected: live.get(url) === true }))
}

/**
 * Match what nostr-tools' SimplePool does internally when it stores
 * relay URLs (parses via WHATWG URL, which canonicalizes e.g.
 * "wss://nos.lol" → "wss://nos.lol/"). Pool callbacks emit the
 * canonical form, so anything we compare to has to be in the same
 * shape.
 */
export function normalizeRelayUrl(url: string): string {
  try {
    return new URL(url).toString()
  } catch {
    return url
  }
}

function extractRelays(event: NostrEvent): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const tag of event.tags) {
    if (tag[0] !== 'r') continue
    const url = tag[1]
    if (typeof url !== 'string' || url === '') continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  for (const x of b) if (!sa.has(x)) return false
  return true
}
