import { describe, expect, test } from 'bun:test'
import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

import { startOutboxWatcher, normalizeRelayUrl } from '../../src/nostr/outbox'

// Same minimal relay as persistent_sub.test: REQ → EOSE, broadcast()
// pushes an EVENT to every open sub. Author/kind filtering is the
// client's job (nostr-tools matchFilters), exactly as in production —
// so a 10002 broadcast on all subs only reaches the sub whose
// authors filter matches.
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
    stop() {
      server.stop(true)
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(20)
  }
  throw new Error('waitFor timed out')
}

// Re-broadcast until the predicate holds: the bootstrap sub connects
// asynchronously, so a single push can land before its REQ does and be
// dropped by the mock relay (which only sends to already-open subs).
async function broadcastUntil(
  relay: { broadcast(e: unknown): void },
  event: unknown,
  pred: () => boolean,
  ms = 2000,
): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    relay.broadcast(event)
    if (pred()) return
    await sleep(40)
  }
  throw new Error('broadcastUntil timed out')
}

let clock = Math.floor(Date.now() / 1000)
function relayList(sk: Uint8Array, relays: string[]) {
  // Distinct, increasing created_at so each event supersedes the last
  // (replaceable dedupe is by created_at inside the watcher).
  return finalizeEvent(
    {
      kind: 10002,
      created_at: ++clock,
      tags: relays.map((r) => ['r', r]),
      content: '',
    },
    sk,
  )
}

function dmRelayList(sk: Uint8Array, relays: string[], createdAt?: number) {
  // Kind 10050 carries `relay` tags (NIP-17), not NIP-65's 'r'.
  return finalizeEvent(
    {
      kind: 10050,
      created_at: createdAt ?? ++clock,
      tags: relays.map((r) => ['relay', r]),
      content: '',
    },
    sk,
  )
}

const norm = (urls: string[]) => urls.map(normalizeRelayUrl).sort()

describe('startOutboxWatcher precedence', () => {
  test('user > operator > static fallback, with empty user falling through', async () => {
    const PORT = 48923
    const URL = `ws://127.0.0.1:${PORT}`
    const relay = startMockRelay(PORT)
    const pool = new SimplePool({ enableReconnect: true, enablePing: true })

    const operatorSk = generateSecretKey()
    const userSk = generateSecretKey()
    const operatorPub = getPublicKey(operatorSk)
    const userPub = getPublicKey(userSk)

    const STATIC = ['wss://static.example/']

    const outbox = await startOutboxWatcher({
      pool,
      fallbackPubkey: operatorPub,
      bootstrapRelays: [URL],
      fallback: STATIC,
      initialTimeoutMs: 300,
    })

    try {
      // 1. Nothing resolved yet → static last-resort.
      expect(outbox.getOutboxSource()).toBe('fallback')
      expect(norm(outbox.getOutboxRelays())).toEqual(norm(STATIC))
      expect(outbox.isResolved()).toBe(false)

      // 2. Operator 10002 arrives → operator wins (no user key yet).
      await broadcastUntil(
        relay,
        relayList(operatorSk, ['wss://op-a.example', 'wss://op-b.example']),
        () => outbox.getOutboxSource() === 'operator',
      )
      expect(norm(outbox.getOutboxRelays())).toEqual(
        norm(['wss://op-a.example', 'wss://op-b.example']),
      )
      expect(outbox.isResolved()).toBe(true)

      // 3. Account key registered + its 10002 arrives → user takes precedence.
      outbox.setPrimaryPubkey(userPub)
      await broadcastUntil(
        relay,
        relayList(userSk, ['wss://user-a.example']),
        () => outbox.getOutboxSource() === 'user',
      )
      expect(norm(outbox.getOutboxRelays())).toEqual(norm(['wss://user-a.example']))

      // 4. User publishes an empty 10002 → "I publish nowhere" must fall
      //    back to the operator, not pin the stale user list.
      await broadcastUntil(
        relay,
        relayList(userSk, []),
        () => outbox.getOutboxSource() === 'operator',
      )
      expect(norm(outbox.getOutboxRelays())).toEqual(
        norm(['wss://op-a.example', 'wss://op-b.example']),
      )
    } finally {
      await outbox.stop()
      pool.close([URL])
      relay.stop()
    }
  })
})

describe('startOutboxWatcher DM relay list (10050)', () => {
  test('tracks the primary key 10050 without touching the active outbox set', async () => {
    const PORT = 48924
    const URL = `ws://127.0.0.1:${PORT}`
    const relay = startMockRelay(PORT)
    const pool = new SimplePool({ enableReconnect: true, enablePing: true })

    const operatorSk = generateSecretKey()
    const userSk = generateSecretKey()
    const userPub = getPublicKey(userSk)

    const outbox = await startOutboxWatcher({
      pool,
      fallbackPubkey: getPublicKey(operatorSk),
      bootstrapRelays: [URL],
      fallback: ['wss://static.example/'],
      initialTimeoutMs: 300,
    })

    try {
      // No primary key yet → no DM list, and a 10050 for an unknown key
      // must not register (there is no sub for it anyway).
      expect(outbox.hasDmRelayList()).toBe(false)
      expect(outbox.getDmRelays()).toEqual([])

      outbox.setPrimaryPubkey(userPub)
      const before = outbox.getOutboxRelays()
      await broadcastUntil(
        relay,
        dmRelayList(userSk, ['wss://dm-a.example', 'wss://dm-b.example']),
        () => outbox.hasDmRelayList(),
      )
      expect(norm(outbox.getDmRelays())).toEqual(norm(['wss://dm-a.example', 'wss://dm-b.example']))
      // Decoupling: the DM list never feeds the NWC relay set.
      expect(outbox.getOutboxRelays()).toEqual(before)
      expect(outbox.getOutboxSource()).toBe('fallback')

      // Replaceable dedupe: an older 10050 must not roll the list back.
      relay.broadcast(dmRelayList(userSk, ['wss://stale.example'], 1))
      await sleep(150)
      expect(norm(outbox.getDmRelays())).toEqual(norm(['wss://dm-a.example', 'wss://dm-b.example']))

      // Newer 10050 replaces.
      await broadcastUntil(
        relay,
        dmRelayList(userSk, ['wss://dm-c.example']),
        () => norm(outbox.getDmRelays()).join() === norm(['wss://dm-c.example']).join(),
      )

      // Re-registering a different primary key resets DM state — a stale
      // list must not outlive the key it belonged to.
      outbox.setPrimaryPubkey(getPublicKey(generateSecretKey()))
      expect(outbox.hasDmRelayList()).toBe(false)
      expect(outbox.getDmRelays()).toEqual([])
      // Let the fresh subs' REQs land before teardown closes the socket —
      // otherwise their async sends surface as unhandled rejections.
      await sleep(250)
    } finally {
      await outbox.stop()
      pool.close([URL])
      relay.stop()
    }
  })
})
