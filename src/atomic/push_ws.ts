import type { Database } from 'bun:sqlite'
import { SqliteAtomicSwapRepository } from './repository'

// Push channel for atomic swaps. subdustd emits every swap state transition on
// `/v2/ws` (subdustd/push.ts — the subset of the Boltz sidecar's `swap.update`
// protocol this client was first written against). We subscribe by swap id and
// poke the reconciler the moment something moves, collapsing the 30s polling
// latency to ~RTT.
//
// Strictly an accelerator: the 30s reconciler stays the source of truth, so
// a dead endpoint (subdustd down, wrong URL) degrades to polling — the client
// just keeps retrying quietly.
//
// Wire protocol:
//   C→S {op:'subscribe'|'unsubscribe', channel:'swap.update', args:[ids]}
//       {op:'ping'}
//   S→C {event:'subscribe'|'unsubscribe'|'update'|'pong'|'error', ...}
//       update args: [{id, status, ...}]

export interface PushWsDeps {
  /** ws(s):// endpoint. undefined disables the client (no-op handle). */
  url: string | undefined
  db: Database
  /** Fired when any subscribed swap transitions — caller re-reconciles. */
  onPoke: () => void
  log?: (msg: string) => void
  /** Test hooks — production callers should leave the defaults. */
  resyncIntervalMs?: number
  reconnectDelayMs?: number
}

export interface PushWs {
  stop(): void
}

// The desired-id resync is a LOCAL sqlite read (listResumable, sub-ms), not
// a network poll — it exists so swaps created after connect get subscribed
// without threading a callback through every issue/send call site.
const RESYNC_INTERVAL_MS = 5_000
const RECONNECT_DELAY_MS = 15_000
const PING_INTERVAL_MS = 30_000
// The ws server caps subscribe args at 100 per message.
const MAX_ARGS_PER_MSG = 100

/** ws(s)://host/v2/ws from subdustd's http(s) API base, where it serves the channel. */
export function derivePushWsUrl(subdustdUrl: string): string | undefined {
  try {
    const u = new URL(subdustdUrl)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = `${u.pathname.replace(/\/$/, '')}/v2/ws`
    return u.toString()
  } catch {
    return undefined
  }
}

export function startPushWs(deps: PushWsDeps): PushWs {
  const log = deps.log ?? console.log
  const resyncMs = deps.resyncIntervalMs ?? RESYNC_INTERVAL_MS
  const reconnectMs = deps.reconnectDelayMs ?? RECONNECT_DELAY_MS

  if (!deps.url) {
    return { stop() {} }
  }
  const url = deps.url

  const repo = new SqliteAtomicSwapRepository(deps.db)
  let ws: WebSocket | null = null
  let stopped = false
  let loggedDown = false
  // What we believe the server tracks for this connection. Optimistic — an
  // ack we miss just means the next resync re-sends, which the server
  // treats as idempotent.
  let subscribed = new Set<string>()
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let resyncTimer: ReturnType<typeof setInterval> | undefined
  let pingTimer: ReturnType<typeof setInterval> | undefined

  const send = (msg: Record<string, unknown>): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const sendIds = (op: 'subscribe' | 'unsubscribe', ids: string[]): void => {
    for (let i = 0; i < ids.length; i += MAX_ARGS_PER_MSG) {
      send({ op, channel: 'swap.update', args: ids.slice(i, i + MAX_ARGS_PER_MSG) })
    }
  }

  // Diff the desired set (non-terminal atomic swaps, both directions)
  // against what's subscribed. Failure-proof: a throw here (db closing
  // mid-shutdown) must not take the timer chain down.
  const resync = (): void => {
    if (stopped || ws?.readyState !== WebSocket.OPEN) return
    try {
      const desired = new Set(repo.listResumable().map((s) => s.id))
      const toAdd = [...desired].filter((id) => !subscribed.has(id))
      const toDrop = [...subscribed].filter((id) => !desired.has(id))
      if (toAdd.length > 0) sendIds('subscribe', toAdd)
      if (toDrop.length > 0) sendIds('unsubscribe', toDrop)
      subscribed = desired
    } catch (err) {
      console.warn('push-ws: resync failed:', err)
    }
  }

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, reconnectMs)
  }

  const connect = (): void => {
    if (stopped) return
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (err) {
      // Malformed URL etc. — log once, keep the poll as the only path.
      if (!loggedDown) {
        loggedDown = true
        console.warn(`push-ws: cannot connect to ${url}:`, err)
      }
      scheduleReconnect()
      return
    }
    ws = socket

    socket.addEventListener('open', () => {
      if (stopped) return
      loggedDown = false
      log(`push-ws: connected (${url})`)
      // Fresh connection knows nothing — resubscribe from scratch.
      subscribed = new Set()
      resync()
    })
    socket.addEventListener('message', (ev) => {
      if (stopped) return
      try {
        const msg = JSON.parse(String(ev.data)) as {
          event?: string
          channel?: string
          args?: { id?: string; status?: string }[]
        }
        if (msg.event !== 'update' || msg.channel !== 'swap.update') return
        for (const a of msg.args ?? []) {
          if (a.id) log(`push-ws: swap ${a.id.slice(0, 8)}… → ${a.status ?? '?'}`)
        }
        deps.onPoke()
      } catch {
        // Not our message shape — ignore.
      }
    })
    socket.addEventListener('close', () => {
      if (ws !== socket) return // superseded by a newer connection
      ws = null
      if (stopped) return
      if (!loggedDown) {
        loggedDown = true
        log(`push-ws: disconnected — reconnecting every ${Math.round(reconnectMs / 1000)}s (poll still covers)`)
      }
      scheduleReconnect()
    })
    // 'error' always precedes 'close' for failed connects; close handles it.
    socket.addEventListener('error', () => {})
  }

  connect()
  resyncTimer = setInterval(resync, resyncMs)
  // Keepalive: NAT/idle timeouts between compose networks are unlikely but
  // free to guard against; the server answers with an `event: pong`.
  pingTimer = setInterval(() => send({ op: 'ping' }), PING_INTERVAL_MS)

  return {
    stop() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearInterval(resyncTimer)
      clearInterval(pingTimer)
      try {
        ws?.close()
      } catch {
        // teardown is best-effort
      }
      ws = null
    },
  }
}
