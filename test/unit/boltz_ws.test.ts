import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteAtomicSwapRepository, SwapDirection } from '../../src/atomic'
import { startBoltzWs, deriveBoltzWsUrl, type BoltzWs } from '../../src/atomic/boltz_ws'

// Mock of the boltz sidecar's swap.update ws: records subscribe/unsubscribe
// ops and lets tests push update events to every connection.
function startMockBoltzWs(port: number) {
  const received: { op: string; args?: string[] }[] = []
  const sockets = new Set<{ send(s: string): void; close(): void }>()
  const server = Bun.serve({
    port,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined as unknown as Response
      return new Response('ws only')
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
      },
      close(ws) {
        sockets.delete(ws)
      },
      message(ws, msg) {
        const data = JSON.parse(String(msg)) as { op: string; channel?: string; args?: string[] }
        received.push({ op: data.op, args: data.args })
        if (data.op === 'subscribe' || data.op === 'unsubscribe') {
          ws.send(
            JSON.stringify({
              event: data.op,
              channel: 'swap.update',
              args: data.args,
              timestamp: 'now',
            }),
          )
        } else if (data.op === 'ping') {
          ws.send(JSON.stringify({ event: 'pong' }))
        }
      },
    },
  })
  return {
    received,
    pushUpdate(id: string, status: string) {
      for (const ws of sockets) {
        ws.send(
          JSON.stringify({
            event: 'update',
            channel: 'swap.update',
            args: [{ id, status }],
            timestamp: 'now',
          }),
        )
      }
    },
    dropAll() {
      for (const ws of sockets) ws.close()
    },
    stop() {
      server.stop(true)
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(20)
  }
  throw new Error('waitFor timed out')
}

let db: Database
let repo: SqliteAtomicSwapRepository
let client: BoltzWs | undefined

beforeEach(() => {
  db = new Database(':memory:')
  SqliteAtomicSwapRepository.migrate(db)
  repo = new SqliteAtomicSwapRepository(db)
})
afterEach(() => {
  client?.stop()
  client = undefined
  db.close()
})

function plantReceive(id: string): void {
  repo.create({
    id,
    direction: SwapDirection.Receive,
    paymentHash: id.padEnd(64, '0'),
    state: 'invoice_issued',
    amount: 21,
    refundLocktime: 0,
  })
}

describe('deriveBoltzWsUrl', () => {
  test('http→ws, https→wss, /v2/ws appended, garbage → undefined', () => {
    expect(deriveBoltzWsUrl('http://boltz:9001')).toBe('ws://boltz:9001/v2/ws')
    expect(deriveBoltzWsUrl('https://boltz.example/')).toBe('wss://boltz.example/v2/ws')
    expect(deriveBoltzWsUrl('not a url')).toBeUndefined()
  })
})

describe('startBoltzWs', () => {
  test('subscribes pending swaps, pokes on update, unsubscribes terminal', async () => {
    const PORT = 48930
    const relay = startMockBoltzWs(PORT)
    plantReceive('swap-a')
    const pokes: number[] = []
    client = startBoltzWs({
      url: `ws://127.0.0.1:${PORT}`,
      db,
      onPoke: () => pokes.push(Date.now()),
      log: () => {},
      resyncIntervalMs: 30,
      reconnectDelayMs: 50,
    })
    try {
      await waitFor(() =>
        relay.received.some((m) => m.op === 'subscribe' && m.args?.includes('swap-a')),
      )

      relay.pushUpdate('swap-a', 'funded')
      await waitFor(() => pokes.length >= 1)

      // New swap appears → next resync subscribes it without any wiring.
      plantReceive('swap-b')
      await waitFor(() =>
        relay.received.some((m) => m.op === 'subscribe' && m.args?.includes('swap-b')),
      )

      // Terminal swap gets unsubscribed on resync.
      repo.transition('swap-a', 'funded')
      repo.transition('swap-a', 'claimed')
      repo.transition('swap-a', 'settled')
      await waitFor(() =>
        relay.received.some((m) => m.op === 'unsubscribe' && m.args?.includes('swap-a')),
      )
    } finally {
      relay.stop()
    }
  })

  test('reconnects after a drop and resubscribes from scratch', async () => {
    const PORT = 48931
    const relay = startMockBoltzWs(PORT)
    plantReceive('swap-r')
    client = startBoltzWs({
      url: `ws://127.0.0.1:${PORT}`,
      db,
      onPoke: () => {},
      log: () => {},
      resyncIntervalMs: 30,
      reconnectDelayMs: 40,
    })
    try {
      await waitFor(() => relay.received.some((m) => m.op === 'subscribe'))
      const before = relay.received.filter((m) => m.op === 'subscribe').length

      relay.dropAll()
      await waitFor(
        () => relay.received.filter((m) => m.op === 'subscribe').length > before,
        4000,
      )
    } finally {
      relay.stop()
    }
  })

  test('undefined url is a no-op handle', () => {
    client = startBoltzWs({ url: undefined, db, onPoke: () => {}, log: () => {} })
    client.stop()
  })
})
