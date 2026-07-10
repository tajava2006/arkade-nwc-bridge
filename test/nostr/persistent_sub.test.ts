import { describe, expect, test } from 'bun:test'
import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'

import { openPersistentSub } from '../../src/nostr/persistent_sub'

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
  test(
    'a failed reconnect no longer kills subs (upstream #538): both subs re-attach on relay return',
    async () => {
      const PORT = 48911
      const URL = `ws://127.0.0.1:${PORT}`
      let relay = startMockRelay(PORT)
      const pool = new SimplePool({ enableReconnect: true, enablePing: true })

      const persistentGot: string[] = []
      const rawGot: string[] = []

      const psub = openPersistentSub({
        pool,
        relays: [URL],
        label: 'test',
        filter: { kinds: [1] },
        resumeSince: true,
        retryIntervalMs: 300,
        onevent: (e) => persistentGot.push(e.content),
      })
      const rawSub = pool.subscribeMany(
        [URL],
        { kinds: [1], since: Math.floor(Date.now() / 1000) },
        { onevent: (e) => rawGot.push(e.content) },
      )

      // Shrink nostr-tools' internal reconnect backoff (default 10s; the
      // last entry repeats forever) so the failed-reconnect path triggers
      // fast enough for a test.
      const abstractRelay = await pool.ensureRelay(URL)
      ;(abstractRelay as unknown as { resubscribeBackoff: number[] }).resubscribeBackoff = [50]

      await sleep(500)
      expect(relay.reqCount()).toBe(2) // persistent + raw

      relay.broadcast(makeEvent('A'))
      await sleep(300)
      expect(persistentGot).toEqual(['A'])
      expect(rawGot).toEqual(['A'])

      // Drop the relay; the 50ms reconnect attempts hit a closed port.
      // nostr-tools < 2.23.9 set skipReconnection=true on the first failed
      // retry and permanently closed every sub on the socket — the bug that
      // motivated persistent_sub. Upstream nbd-wtf/nostr-tools#538 (our
      // fix, shipped in 2.23.9) gates that on the initial connection only,
      // so mid-outage retries keep backing off and every sub re-REQs when
      // the relay returns; the persistent wrapper never even sees an
      // onclose here. If reqCount drops back to 1, upstream has regressed
      // and persistent_sub is load-bearing for outages again. What #538
      // does NOT fix — and persistent_sub still owns — is a relay that is
      // down at first attach (initial connect failure still kills the
      // socket's subs), plus the capped `since` resume.
      relay.stop()
      await sleep(600)

      relay = startMockRelay(PORT)
      await sleep(1000)

      expect(relay.reqCount()).toBe(2) // both re-attached by upstream

      relay.broadcast(makeEvent('B'))
      await sleep(300)
      expect(persistentGot).toEqual(['A', 'B'])
      expect(rawGot).toEqual(['A', 'B'])

      psub.close()
      rawSub.close()
      pool.close([URL])
      relay.stop()
    },
    10_000,
  )

  test('dedupes the same event arriving from multiple relays', async () => {
    const URLS = ['ws://127.0.0.1:48912', 'ws://127.0.0.1:48913']
    const r1 = startMockRelay(48912)
    const r2 = startMockRelay(48913)
    const pool = new SimplePool({ enableReconnect: true, enablePing: true })

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
