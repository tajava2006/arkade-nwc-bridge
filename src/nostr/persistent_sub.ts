import type { SimplePool } from 'nostr-tools/pool'
import type { Filter } from 'nostr-tools/filter'
import type { NostrEvent } from 'nostr-tools/pure'

type SubCloser = ReturnType<SimplePool['subscribeMany']>

// Why this exists: nostr-tools' enableReconnect only survives drops
// where its *first* retry succeeds. If that retry also fails (relay
// reboot longer than the 10s backoff, network blip), AbstractRelay
// sets skipReconnection=true, permanently closes every Subscription on
// the socket, and the pool forgets the relay. The index.ts watchdog
// resurrects the *socket*, but the fresh AbstractRelay starts with
// zero subscriptions — nothing re-issues the REQ, so the bridge sits
// "connected" but deaf. This wrapper owns one sub per relay and
// re-subscribes after that permanent-death path. (The quick-reconnect
// path needs no help: subs stay in openSubs and re-fire on reconnect.)

const RETRY_INTERVAL_MS = 5000
// Resume skew covers the zombie window before enablePing notices a
// dead socket (pingFrequency 29s + pingTimeout 20s): requests stored
// on the relay during that window predate the observed death time.
const RESUME_SKEW_SEC = 60
// Cap the lookback so a long one-sided outage (relay reachable, our
// link down) can't replay hours-old money-moving requests on recovery.
// processed_events + expiration tags + invoice expiry are backstops,
// but a stale pay_invoice inside all three is still a surprise payment.
const MAX_RESUME_LOOKBACK_SEC = 300
const SEEN_IDS_MAX = 4096

export interface PersistentSubOptions {
  pool: SimplePool
  /** Relay URLs, already normalized to the pool's WHATWG form. */
  relays: readonly string[]
  /**
   * Base filter, shared by every relay. With `resumeSince` the helper
   * manages `since` itself: "now" on first subscribe, the (skewed,
   * capped) death time on re-subscribe. Without it the filter is sent
   * verbatim on every attach — right for replaceable-event fetches
   * where the latest stored event is always wanted.
   */
  filter: Filter
  resumeSince?: boolean
  onevent: (event: NostrEvent) => void
  label: string
  /** Test hook — production callers should leave the 5s default. */
  retryIntervalMs?: number
}

export interface PersistentSub {
  close(): void
}

interface RelayEntry {
  serial: number
  alive: boolean
  /** Wall-clock ms of the death that opened the current retry cycle. */
  deadSinceMs: number | null
  closer: SubCloser | null
}

export function openPersistentSub(opts: PersistentSubOptions): PersistentSub {
  const { pool } = opts

  const entries = new Map<string, RelayEntry>()
  for (const url of opts.relays) {
    if (!entries.has(url)) {
      entries.set(url, { serial: 0, alive: false, deadSinceMs: null, closer: null })
    }
  }

  // Cross-relay dedupe. A single subscribeMany over all relays would
  // dedupe internally, but we need one sub *per relay* so each relay
  // dies and heals independently. Plugging into params.alreadyHaveEvent
  // restores the same suppression across our independent subs — without
  // it one NWC request arriving from N relays would dispatch N times.
  const seenIds = new Set<string>()
  const alreadyHaveEvent = (id: string): boolean => {
    if (seenIds.has(id)) return true
    seenIds.add(id)
    if (seenIds.size > SEEN_IDS_MAX) {
      for (const old of seenIds) {
        seenIds.delete(old)
        if (seenIds.size <= SEEN_IDS_MAX / 2) break
      }
    }
    return false
  }

  let serialCounter = 0
  let closed = false

  const attach = (url: string): void => {
    const entry = entries.get(url)
    if (!entry) return
    const mySerial = ++serialCounter
    entry.serial = mySerial
    entry.alive = true
    // Copy per attach: AbstractRelay mutates filter.since in place on
    // its quick-reconnect path, so a shared object would leak that
    // mutation between relays.
    const filter: Filter = { ...opts.filter }
    if (opts.resumeSince) {
      const nowSec = Math.floor(Date.now() / 1000)
      filter.since =
        entry.deadSinceMs === null
          ? nowSec
          : Math.max(
              Math.floor(entry.deadSinceMs / 1000) - RESUME_SKEW_SEC,
              nowSec - MAX_RESUME_LOOKBACK_SEC,
            )
    }
    entry.closer = pool.subscribeMany([url], filter, {
      label: opts.label,
      onevent: opts.onevent,
      alreadyHaveEvent,
      onclose: () => {
        if (closed) return
        const cur = entries.get(url)
        // Serial guard: a late onclose from a superseded attach must
        // not mark the current sub dead.
        if (!cur || cur.serial !== mySerial) return
        cur.alive = false
        cur.deadSinceMs ??= Date.now()
      },
    })
  }

  for (const url of entries.keys()) attach(url)

  const timer = setInterval(() => {
    for (const [url, entry] of entries) {
      if (!entry.alive) {
        attach(url)
      } else {
        // Survived a full tick since (re)attach — treat as recovered so
        // the *next* death opens a fresh resume window instead of
        // dragging the old timestamp along.
        entry.deadSinceMs = null
      }
    }
  }, opts.retryIntervalMs ?? RETRY_INTERVAL_MS)

  return {
    close() {
      if (closed) return
      closed = true
      clearInterval(timer)
      for (const entry of entries.values()) {
        entry.closer?.close('persistent sub closed')
      }
      entries.clear()
    },
  }
}
