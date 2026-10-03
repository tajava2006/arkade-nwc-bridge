import { describe, expect, test } from 'bun:test'
import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'

import { openPersistentSub } from '../../src/nostr/persistent_sub'
import { createRelayGate } from '../../src/nostr/relay_gate'

// Minimal NIP-01 relay: REQ → EOSE, tracks subids, broadcast() pushes an
// EVENT to every open subscription. Filter matching is left to the
// client (nostr-tools matchFilters), which is what production does too.
function startMockRelay(port: number) {
  const subs = new Map<unknown, Set<string>>()
  const server = Bun.serve({
    port,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined as unknown as Response
      return new Response('ws only')
    },
    websocket: {
      open(ws) {
        subs.set(ws, new Set())
      },
      close(ws) {
        subs.delete(ws)
      },
      message(ws, msg) {
        const data = JSON.parse(String(msg))
        if (data[0] === 'REQ') {
          subs.get(ws)?.add(data[1])
          ws.send(JSON.stringify(['EOSE', data[1]]))
        } else if (data[0] === 'CLOSE') {
          subs.get(ws)?.delete(data[1])
        }
      },
    },
  })
  return {
    broadcast(event: unknown) {
      for (const [ws, ids] of subs) {
        for (const id of ids) {
          ;(ws as { send(s: string): void }).send(JSON.stringify(['EVENT', id, event]))
        }
      }
    },
    socketCount() {
      return subs.size
    },
    reqCount() {
      let n = 0
      for (const ids of subs.values()) n += ids.size
      return n
    },
    stop() {
      server.stop(true)
    },
  }
}

const sk = generateSecretKey()
const makeEvent = (content: string) =>
  finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content }, sk)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('openPersistentSub', () => {
  // Production wiring (index.ts): no enableReconnect, the relay gate as
  // the pool's connect hook, and a watchdog calling gate.ensure.
  const productionPool = () => {
    const pool = new SimplePool({ enablePing: true })
    const gate = createRelayGate({ pool, baseDelayMs: 100, stableAfterMs: 0, log: () => {} })
    pool.allowConnectingToRelay = (url) => gate.allow(url)
    pool.onRelayConnectionSuccess = (url) => gate.succeeded(url)
    pool.onRelayConnectionFailure = (url) => gate.failed(url)
    return { pool, gate }
  }

  test(
    're-attaches after an outage and resumes delivery',
    async () => {
      const PORT = 48911
      const URL = `ws://127.0.0.1:${PORT}`
      let relay = startMockRelay(PORT)
      const { pool } = productionPool()

      const got: string[] = []
      const psub = openPersistentSub({
        pool,
        relays: [URL],
        label: 'test',
        filter: { kinds: [1] },
        resumeSince: true,
        retryIntervalMs: 100,
        onevent: (e) => got.push(e.content),
      })

      await sleep(400)
      expect(relay.reqCount()).toBe(1)
      relay.broadcast(makeEvent('A'))
      await sleep(200)
      expect(got).toEqual(['A'])

      relay.stop()
      await sleep(600)
      relay = startMockRelay(PORT)
      await sleep(1500)

      expect(relay.reqCount()).toBe(1)
      relay.broadcast(makeEvent('B'))
      await sleep(200)
      expect(got).toEqual(['A', 'B'])

      psub.close()
      pool.close([URL])
      relay.stop()
    },
    10_000,
  )

  test(
    'repeated outages never leave more than one socket to the relay',
    async () => {
      // Regression: with enableReconnect on, nostr-tools' internal
      // reconnect loop and a pool-level connect attempt raced during an
      // outage — the pool dropped the relay object, the object kept
      // reconnecting by itself, and the next ensureRelay built another.
      // One extra live socket per outage, forever.
      const PORT = 48914
      const URL = `ws://127.0.0.1:${PORT}`
      let relay = startMockRelay(PORT)
      const { pool, gate } = productionPool()

      const psubs = [0, 1, 2].map((i) =>
        openPersistentSub({
          pool,
          relays: [URL],
          label: `leak-${i}`,
          filter: { kinds: [1] },
          resumeSince: true,
          retryIntervalMs: 100,
          onevent: () => {},
        }),
      )
      const watchdog = setInterval(() => void gate.ensure(URL), 100)

      await sleep(400)
      expect(relay.socketCount()).toBe(1)

      for (let cycle = 0; cycle < 3; cycle++) {
        relay.stop()
        await sleep(500)
        relay = startMockRelay(PORT)
        await sleep(1500)
        expect(relay.socketCount()).toBe(1)
        expect(relay.reqCount()).toBe(3)
      }

      clearInterval(watchdog)
      for (const p of psubs) p.close()
      pool.close([URL])
      relay.stop()
    },
    15_000,
  )

  test('dedupes the same event arriving from multiple relays', async () => {
    const URLS = ['ws://127.0.0.1:48912', 'ws://127.0.0.1:48913']
    const r1 = startMockRelay(48912)
    const r2 = startMockRelay(48913)
    const pool = new SimplePool({ enablePing: true })

    let count = 0
    const psub = openPersistentSub({
      pool,
      relays: URLS,
      label: 'dedupe',
      filter: { kinds: [1] },
      resumeSince: true,
      onevent: () => {
        count++
      },
    })

    await sleep(500)
    const event = makeEvent('dup')
    r1.broadcast(event)
    r2.broadcast(event)
    await sleep(500)

    expect(count).toBe(1)

    psub.close()
    pool.close(URLS)
    r1.stop()
    r2.stop()
  })
})
