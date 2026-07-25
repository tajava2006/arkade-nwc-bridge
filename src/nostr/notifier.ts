import { getPublicKey } from 'nostr-tools/pure'
import { wrapEvent } from 'nostr-tools/nip17'
import type { SimplePool } from 'nostr-tools/pool'

import { publishToRelays } from './publish'

// Operational self-DMs: the account key gift-wraps a NIP-17 message to its
// own npub for every notable payment/health event. The operator reads them
// in whatever NIP-17 client holds the same identity (the account nsec IS
// the operator's nostr identity — see README "Backup the nsec separately").
//
// The one hard rule: a broken notifier must not change bridge behavior.
// notify() is synchronous, swallows everything (including the message
// thunk), and the publish loop runs detached — no money path ever awaits
// any of this.

/**
 * Event categories. Every notify() call names one so a future settings
 * surface can toggle categories per kind — today they are all enabled
 * (see NotifierDeps.enabled). Letters reference the hook map in the
 * implementation plan; kept here as the one list to extend.
 */
export const NOTIFY_KINDS = [
  'recv-ln', //       dust+ invoice settled (reverse swap)
  'recv-noffer', //   CLINK noffer/zap settled
  'recv-subdust', //  atomic sub-dust receive settled
  'onboard', //       onchain boarding deposit detected / settled (boarding_history.ts)
  'send-ln', //       dust+ invoice paid (submarine swap)
  'send-subdust', //  atomic sub-dust paid / claim recovered
  'send-fail', //     a send failed after its swap existed
  'refund', //        atomic or submarine refund landed
  'offboard', //      onchain offboard settled/failed
  'health-asp', //    proof sync failing/recovered (ASP reachability)
  'health-vault', //  vtxo quarantined / expired-unrefreshed batch
  'health-boot', //   degraded mode entered/recovered
] as const

export type NotifyKind = (typeof NOTIFY_KINDS)[number]

/**
 * The hook-site shape: a kind plus a lazily-built message. The thunk is
 * evaluated inside the notifier's try/catch, so hook sites may decode
 * invoices / parse JSON / encode npubs in the template without any risk
 * of leaking a throw into the calling (money) path.
 */
export type NotifyFn = (kind: NotifyKind, build: () => string) => void

export interface NotifierDeps {
  pool: SimplePool
  /** Account key — sender and recipient of every DM. */
  secretKey: Uint8Array
  /**
   * Live source of the account's NIP-17 DM inbox relays (kind 10050,
   * outbox.getDmRelays). Empty = "no NIP-17 client is set up" — the
   * notifier's gate: items are dropped rather than published somewhere
   * no client reads (NIP-17 prescribes the recipient's 10050).
   */
  dmRelays: () => readonly string[]
  /** Per-kind toggle; absent = every kind enabled. */
  enabled?: (kind: NotifyKind) => boolean
  log?: (msg: string) => void
  /** Test hooks — production callers should leave the defaults. */
  gateGraceMs?: number
  gateRecheckMs?: number
}

export interface Notifier {
  notify: NotifyFn
  /** Queued items not yet published (diagnostics/tests). */
  pendingCount(): number
  stop(): void
}

// Bounded so a long relay outage (drain blocked on nothing — publishes
// are best-effort — but a missing 10050 past its grace, or a stopped
// loop) can't grow memory unbounded. Oldest drop first: newer events
// matter more to an operator catching up.
const MAX_QUEUE = 64
// Cold-boot race: a health event can fire before the outbox watcher has
// resolved the 10050 list. Items younger than this wait and re-check
// instead of being gate-dropped immediately.
const GATE_GRACE_MS = 30_000
const GATE_RECHECK_MS = 5_000

interface QueueItem {
  kind: NotifyKind
  text: string
  at: number
}

export function startNotifier(deps: NotifierDeps): Notifier {
  const log = deps.log ?? console.log
  const graceMs = deps.gateGraceMs ?? GATE_GRACE_MS
  const recheckMs = deps.gateRecheckMs ?? GATE_RECHECK_MS
  const selfPubkey = getPublicKey(deps.secretKey)

  const queue: QueueItem[] = []
  let stopped = false
  let draining = false

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const currentDmRelays = (): string[] => {
    try {
      return [...deps.dmRelays()]
    } catch (err) {
      console.warn('notifier: dmRelays source threw:', err)
      return []
    }
  }

  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (!stopped && queue.length > 0) {
        const item = queue[0]!
        const relays = currentDmRelays()
        if (relays.length === 0) {
          if (Date.now() - item.at < graceMs) {
            await sleep(recheckMs)
            continue
          }
          queue.shift()
          log(`notifier: no DM relay list (10050) — dropping '${item.kind}'`)
          continue
        }
        queue.shift()
        try {
          // Fresh rumor→seal→wrap per message; the wrap is signed by a
          // throwaway key (NIP-59), so nothing public links messages to
          // each other or to the account key.
          const wrap = wrapEvent(deps.secretKey, { publicKey: selfPubkey }, item.text)
          await publishToRelays(deps.pool, relays, wrap, `notifier DM (${item.kind})`)
        } catch (err) {
          console.warn(`notifier: failed to send '${item.kind}':`, err)
        }
      }
    } finally {
      draining = false
    }
  }

  const notify: NotifyFn = (kind, build) => {
    if (stopped) return
    try {
      if (deps.enabled && !deps.enabled(kind)) return
      const text = build()
      if (queue.length >= MAX_QUEUE) {
        queue.shift()
        console.warn('notifier: queue full — dropping oldest')
      }
      queue.push({ kind, text, at: Date.now() })
      void drain()
    } catch (err) {
      // Never let a notification leak a throw into the caller.
      console.warn(`notifier: dropped '${kind}':`, err)
    }
  }

  return {
    notify,
    pendingCount: () => queue.length,
    stop() {
      stopped = true
      queue.length = 0
      // In-flight publishes are abandoned, not awaited — teardown must
      // not wait on relays (the pool is closed right after us anyway).
    },
  }
}
