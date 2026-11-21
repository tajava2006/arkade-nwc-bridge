import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAtomicSwapRepository, SwapDirection } from '../../src/atomic'
import { deriveBoltzWsUrl, startBoltzWs } from '../../src/atomic/boltz_ws'
import { openDatabase } from '../../src/db'
import { startHttp } from '../../subdustd/http.ts'
import { createLogger } from '../../subdustd/log.ts'
import { PushHub } from '../../subdustd/push.ts'

// subdustd's /v2/ws: the wire protocol, and — the point of it — the bridge's
// own unchanged push client waking its reconciler off subdustd's updates.

const known = new Map<string, string>([['known', 'funded']])
const hub = new PushHub((id) => known.get(id))
let server: ReturnType<typeof startHttp>
let base: string

beforeAll(() => {
  server = startHttp({ http: { host: '127.0.0.1', port: 0 } } as never, createLogger('error', () => {}), { push: hub })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))

const open = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v2/ws`)
  const inbox: any[] = []
  ws.addEventListener('message', (e) => inbox.push(JSON.parse(String(e.data))))
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  const next = async (n = inbox.length + 1) => {
    for (let i = 0; i < 100 && inbox.length < n; i++) await Bun.sleep(10)
    return inbox[n - 1]
  }
  return { ws, inbox, next, send: (m: unknown) => ws.send(JSON.stringify(m)) }
}

describe('subdustd push channel', () => {
  test('subscribe acks and replays the current status; publish pushes; unsubscribe stops it', async () => {
    const c = await open()
    c.send({ op: 'subscribe', channel: 'swap.update', args: ['known', 'fresh'] })
    expect(await c.next(1)).toEqual({ event: 'subscribe', channel: 'swap.update', args: ['known', 'fresh'] })
    expect(await c.next(2)).toEqual({ event: 'update', channel: 'swap.update', args: [{ id: 'known', status: 'funded' }] })
    hub.publish('fresh', 'ln_inflight')
    expect(await c.next(3)).toEqual({ event: 'update', channel: 'swap.update', args: [{ id: 'fresh', status: 'ln_inflight' }] })
    c.send({ op: 'unsubscribe', channel: 'swap.update', args: ['fresh'] })
    expect((await c.next(4)).event).toBe('unsubscribe')
    hub.publish('fresh', 'claimed')
    await Bun.sleep(50)
    expect(c.inbox).toHaveLength(4)
    expect(hub.subscriberCount('fresh')).toBe(0)
    c.ws.close()
  })

  test('ping, and every malformed message answers an error instead of closing the socket', async () => {
    const c = await open()
    c.send({ op: 'ping' })
    expect(await c.next(1)).toEqual({ event: 'pong' })
    c.ws.send('not json')
    c.send({ op: 'nope' })
    c.send({ op: 'subscribe', channel: 'other', args: ['x'] })
    c.send({ op: 'subscribe', channel: 'swap.update', args: Array.from({ length: 101 }, (_, i) => `id${i}`) })
    c.send({ op: 'subscribe', channel: 'swap.update', args: [1] })
    for (let i = 2; i <= 6; i++) expect((await c.next(i)).event).toBe('error')
    c.send({ op: 'ping' })
    expect(await c.next(7)).toEqual({ event: 'pong' })
    c.ws.close()
  })

  test('a closed socket leaves no subscriptions behind', async () => {
    const c = await open()
    c.send({ op: 'subscribe', channel: 'swap.update', args: ['gone'] })
    await c.next(1)
    expect(hub.subscriberCount('gone')).toBe(1)
    c.ws.close()
    for (let i = 0; i < 50 && hub.subscriberCount('gone') > 0; i++) await Bun.sleep(10)
    expect(hub.subscriberCount('gone')).toBe(0)
  })

  test('plain GET on /v2/ws asks for an upgrade', async () => {
    expect((await fetch(`${base}/v2/ws`)).status).toBe(426)
  })

  test("the bridge's unchanged client subscribes its open swaps and is poked by subdustd's updates", async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'bridge-push-')), 'bridge.sqlite'))
    new SqliteAtomicSwapRepository(db).create({
      id: 'bridge-swap',
      direction: SwapDirection.Send,
      paymentHash: 'ab'.repeat(32),
      state: 'ln_inflight',
      amount: 21,
      refundLocktime: 1_900_000_000,
    })
    let pokes = 0
    const client = startBoltzWs({
      url: deriveBoltzWsUrl(base),
      db,
      onPoke: () => pokes++,
      log: () => {},
      resyncIntervalMs: 20,
      reconnectDelayMs: 50,
    })
    for (let i = 0; i < 200 && hub.subscriberCount('bridge-swap') === 0; i++) await Bun.sleep(10)
    expect(hub.subscriberCount('bridge-swap')).toBe(1)
    const before = pokes
    hub.publish('bridge-swap', 'claimed')
    for (let i = 0; i < 100 && pokes === before; i++) await Bun.sleep(10)
    expect(pokes).toBe(before + 1)
    client.stop()
    db.close()
  })
})
