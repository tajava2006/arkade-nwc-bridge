import type { ServerWebSocket, WebSocketHandler } from 'bun'

// Push channel: the subset of the Boltz sidecar's `swap.update` WebSocket the
// bridge's client (src/atomic/push_ws.ts) speaks, served at /v2/ws on
// the API port — where that client looks (`${subdustdUrl}/v2/ws`). Pure
// accelerator: the client's 30s reconciler stays the source of truth, so a
// dropped socket costs latency, never correctness.
//
//   C→S {op:'subscribe'|'unsubscribe', channel:'swap.update', args:[ids]}
//       {op:'ping'}
//   S→C {event:'subscribe'|'unsubscribe', channel, args}   ack
//       {event:'update', channel:'swap.update', args:[{id, status}]}
//       {event:'pong'} / {event:'error', reason}
//
// A subscribe is answered with the current status of every known id, so a
// transition that landed before the client subscribed still wakes it.

export const CHANNEL = 'swap.update'
const MAX_ARGS_PER_MESSAGE = 100
// Bounds what one connection can make us remember; the bridge tracks a handful.
const MAX_SUBSCRIPTIONS_PER_SOCKET = 1_000

interface SocketData {
  ids: Set<string>
}

export class PushHub {
  private readonly byId = new Map<string, Set<ServerWebSocket<SocketData>>>()

  constructor(private readonly currentStatus: (id: string) => string | undefined) {}

  publish(id: string, status: string): void {
    const sockets = this.byId.get(id)
    if (!sockets) return
    const msg = JSON.stringify({ event: 'update', channel: CHANNEL, args: [{ id, status }] })
    for (const ws of sockets) ws.send(msg)
  }

  subscriberCount(id: string): number {
    return this.byId.get(id)?.size ?? 0
  }

  newSocketData(): SocketData {
    return { ids: new Set() }
  }

  readonly websocket: WebSocketHandler<SocketData> = {
    message: (ws, raw) => {
      let msg: { op?: unknown; channel?: unknown; args?: unknown }
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return this.error(ws, 'invalid JSON')
      }
      if (msg.op === 'ping') return void ws.send(JSON.stringify({ event: 'pong' }))
      if (msg.op !== 'subscribe' && msg.op !== 'unsubscribe') return this.error(ws, `unknown op ${String(msg.op)}`)
      if (msg.channel !== CHANNEL) return this.error(ws, `unknown channel ${String(msg.channel)}`)
      const args = msg.args
      if (!Array.isArray(args) || args.length > MAX_ARGS_PER_MESSAGE || !args.every((a) => typeof a === 'string')) {
        return this.error(ws, `args must be at most ${MAX_ARGS_PER_MESSAGE} swap ids`)
      }
      const ids = args as string[]
      if (msg.op === 'subscribe') {
        if (ws.data.ids.size + ids.length > MAX_SUBSCRIPTIONS_PER_SOCKET) {
          return this.error(ws, `at most ${MAX_SUBSCRIPTIONS_PER_SOCKET} subscriptions per connection`)
        }
        for (const id of ids) {
          ws.data.ids.add(id)
          let set = this.byId.get(id)
          if (!set) this.byId.set(id, (set = new Set()))
          set.add(ws)
        }
        ws.send(JSON.stringify({ event: 'subscribe', channel: CHANNEL, args: ids }))
        const known = ids.flatMap((id) => {
          const status = this.currentStatus(id)
          return status ? [{ id, status }] : []
        })
        if (known.length > 0) ws.send(JSON.stringify({ event: 'update', channel: CHANNEL, args: known }))
      } else {
        for (const id of ids) this.drop(ws, id)
        ws.send(JSON.stringify({ event: 'unsubscribe', channel: CHANNEL, args: ids }))
      }
    },
    close: (ws) => {
      for (const id of [...ws.data.ids]) this.drop(ws, id)
    },
  }

  private drop(ws: ServerWebSocket<SocketData>, id: string) {
    ws.data.ids.delete(id)
    const set = this.byId.get(id)
    if (!set) return
    set.delete(ws)
    if (set.size === 0) this.byId.delete(id)
  }

  private error(ws: ServerWebSocket<SocketData>, reason: string) {
    ws.send(JSON.stringify({ event: 'error', reason }))
  }
}
