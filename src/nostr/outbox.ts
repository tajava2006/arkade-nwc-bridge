import type { SimplePool } from 'nostr-tools/pool'
import type { NostrEvent } from 'nostr-tools/pure'

import type { RelayStatus } from '../lib/relay_status'
import { openPersistentSub, type PersistentSub } from './persistent_sub'

// NIP-65 "relay list metadata" — replaceable, one per author. The 'r'
// tags carry relay URLs, optionally suffixed with "read" / "write"
// markers. We treat any 'r' as authoritative regardless of marker: the
// goal here is "which relays does this identity currently publish to"
// for NWC defaults, and NWC clients and the bridge talk in both
// directions on the same set so the read/write asymmetry doesn't apply.
const OUTBOX_KIND = 10002

/**
 * Where the active relay set came from, in precedence order:
 *   - 'user'     — the account key's own 10002 (standalone user manages
 *                  their relays via any nostr client)
 *   - 'operator' — the hardcoded fallback pubkey's 10002 (the bridge
 *                  operator's curated list; the default until the user
 *                  publishes their own)
 *   - 'fallback' — neither 10002 resolved yet; the static NWC_RELAYS_FALLBACK
 */
export type OutboxSource = 'user' | 'operator' | 'fallback'

export interface OutboxConfig {
  /**
   * Shared SimplePool. The watcher subscribes on bootstrap relays via
   * this pool and ensures connections to the active relay set through
   * it — same pool the nostr service uses for per-connection subs, so
   * listConnectionStatus is the single source of truth for relay
   * health across the whole bridge.
   */
  pool: SimplePool
  /**
   * Operator identity. Subscribed at boot; its 10002 is the baseline
   * relay set until/unless the account key publishes its own (see
   * setPrimaryPubkey). Named "fallback" because the user's own list,
   * when present, takes precedence.
   */
  fallbackPubkey: string
  bootstrapRelays: readonly string[]
  /**
   * Last-resort static set returned by getOutboxRelays() while neither
   * the user nor the operator 10002 has resolved — e.g. all bootstrap
   * relays unreachable at boot. Also the source of new-connection URIs
   * during that window so the bridge stays usable.
   */
  fallback: readonly string[]
  /**
   * Boot-time grace period. startOutboxWatcher resolves after the first
   * non-empty 10002 lands OR this elapses, whichever first. The watcher
   * keeps running either way — late-arriving updates still fire
   * onOutboxChange.
   */
  initialTimeoutMs?: number
}

export interface OutboxWatcher {
  /** Active relay set (user > operator > static fallback). */
  getOutboxRelays(): string[]
  /** Where getOutboxRelays() is currently sourced from. */
  getOutboxSource(): OutboxSource
  /** True once a non-empty 10002 (either author) has been processed. */
  isResolved(): boolean
  /**
   * Register the account key as the primary discovery target and open a
   * separate subscription for its 10002. Called once the account exists
   * (boot in ready mode, or post-/setup). Idempotent for the same key;
   * a different key resets the user state and re-subscribes. Kept as a
   * standalone sub (not a two-author filter) because relay handling of
   * `authors:[a,b]` + `limit` is inconsistent for replaceable events.
   */
  setPrimaryPubkey(pubkey: string): void
  /** Live connection state of the bootstrap relays this watcher uses. */
  getBootstrapRelayStatus(): RelayStatus[]
  /** Live connection state of the active relay set. */
  getOutboxRelayStatus(): RelayStatus[]
  /** Fires on each *change* to the active set (not on every 10002 event). */
  onOutboxChange(fn: (relays: string[]) => void): () => void
  /** Closes the bootstrap subscriptions. Does not close the shared pool. */
  stop(): Promise<void>
}

interface AuthorState {
  /** Latest 10002 relay list for this author; [] means "publishes nowhere". */
  relays: string[]
  lastCreatedAt: number
}

export async function startOutboxWatcher(cfg: OutboxConfig): Promise<OutboxWatcher> {
  const timeoutMs = cfg.initialTimeoutMs ?? 10_000
  // Normalize so URLs we store/compare match what the pool reports
  // back (post-WHATWG URL, e.g. trailing slash added). Without this,
  // any `bootstrap.includes(url)` comparison would always miss.
  const bootstrap = cfg.bootstrapRelays.map(normalizeRelayUrl)
  const staticFallback = cfg.fallback.map(normalizeRelayUrl)
  const pool = cfg.pool

  // Per-author latest 10002. Operator is known from boot; user is filled
  // in by setPrimaryPubkey once the account key exists.
  const operator: AuthorState = { relays: [], lastCreatedAt: 0 }
  const user: AuthorState = { relays: [], lastCreatedAt: 0 }
  let userPubkey: string | null = null
  let userSub: PersistentSub | null = null

  let effective: string[] = [...staticFallback]
  let source: OutboxSource = 'fallback'
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

  // Recompute the active set from the per-author state under precedence
  // user > operator > static. Fires listeners and ensures connections
  // only on an actual change of the resulting set.
  const recompute = (): void => {
    const next = user.relays.length
      ? user.relays
      : operator.relays.length
        ? operator.relays
        : staticFallback
    source = user.relays.length ? 'user' : operator.relays.length ? 'operator' : 'fallback'
    if (sameSet(effective, next)) return
    effective = [...next]
    ensureConnections(effective)
    for (const l of outboxListeners) {
      try {
        l([...effective])
      } catch (err) {
        console.error('outbox: change listener crashed:', err)
      }
    }
  }

  // Apply one 10002 to its author's state. An empty 'r' set is recorded
  // as [] (not ignored): under the precedence chain "this author
  // publishes nowhere" must let the next tier take over, rather than
  // pinning a stale list. created_at dedupes; relays store a single
  // latest replaceable event so we only ever move forward.
  const applyAuthor = (state: AuthorState, event: NostrEvent): void => {
    if (event.created_at <= state.lastCreatedAt) return
    state.lastCreatedAt = event.created_at
    const relays = extractRelays(event).map(normalizeRelayUrl)
    state.relays = relays
    if (relays.length > 0 && firstResolve) {
      firstResolve()
      firstResolve = null
    }
    recompute()
  }

  const handleEvent = (event: NostrEvent): void => {
    if (event.kind !== OUTBOX_KIND) return
    if (event.pubkey === cfg.fallbackPubkey) {
      applyAuthor(operator, event)
    } else if (userPubkey && event.pubkey === userPubkey) {
      applyAuthor(user, event)
    }
  }

  // Pre-warm bootstrap and the static fallback. subscribeMany on
  // bootstrap will also ensureRelay, but doing it explicitly keeps the
  // intent clear (and seeds status before subscribeMany's handshake).
  ensureConnections(bootstrap)
  ensureConnections(staticFallback)

  // PersistentSub so a bootstrap relay that nostr-tools gives up on
  // (failed reconnect → subscriptions permanently closed) gets its
  // 10002 sub re-issued once the socket is back. No resumeSince: on
  // re-attach we want the latest stored replaceable event regardless
  // of age — applyAuthor dedupes by created_at.
  const operatorSub = openPersistentSub({
    pool,
    relays: bootstrap,
    label: 'outbox-operator',
    filter: {
      kinds: [OUTBOX_KIND],
      authors: [cfg.fallbackPubkey],
      // Replaceable semantics: limit:1 asks for the single latest match.
      // The sub stays open after EOSE so future updates still stream.
      limit: 1,
    },
    onevent: handleEvent,
  })

  await Promise.race([
    firstEvent,
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ])

  return {
    getOutboxRelays: () => [...effective],
    getOutboxSource: () => source,
    isResolved: () => source !== 'fallback',
    setPrimaryPubkey(pubkey: string) {
      if (userPubkey === pubkey) return
      // Account changed (or first registration): drop any prior user sub
      // and state so a stale list can't outlive the key it belonged to.
      if (userSub) {
        userSub.close()
        userSub = null
      }
      userPubkey = pubkey
      user.relays = []
      user.lastCreatedAt = 0
      userSub = openPersistentSub({
        pool,
        relays: bootstrap,
        label: 'outbox-user',
        filter: { kinds: [OUTBOX_KIND], authors: [pubkey], limit: 1 },
        onevent: handleEvent,
      })
      // Clearing prior user state may revert the active set to operator.
      recompute()
    },
    getBootstrapRelayStatus: () => snapshot(pool, bootstrap),
    getOutboxRelayStatus: () => snapshot(pool, effective),
    onOutboxChange(fn) {
      outboxListeners.add(fn)
      return () => {
        outboxListeners.delete(fn)
      }
    },
    async stop() {
      operatorSub.close()
      userSub?.close()
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
