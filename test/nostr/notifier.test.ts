import { describe, expect, test } from 'bun:test'
import { SimplePool } from 'nostr-tools/pool'
import { generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { unwrapEvent } from 'nostr-tools/nip17'

import { startNotifier } from '../../src/nostr/notifier'
import { normalizeRelayUrl } from '../../src/nostr/outbox'

// Mock relay that accepts EVENT publishes (OK-acks them) and records
// what landed — the write-side twin of outbox.test's read-side mock.
function startCaptureRelay(port: number) {
  const captured: NostrEvent[] = []
  const server = Bun.serve({
    port,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined as unknown as Response
      return new Response('ws only')
    },
    websocket: {
      message(ws, msg) {
        const data = JSON.parse(String(msg))
        if (data[0] === 'EVENT') {
          const event = data[1] as NostrEvent
          captured.push(event)
          ws.send(JSON.stringify(['OK', event.id, true, '']))
        } else if (data[0] === 'REQ') {
          ws.send(JSON.stringify(['EOSE', data[1]]))
        }
      },
    },
  })
  return {
    captured,
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

describe('startNotifier', () => {
  test('wraps NIP-17 self-DMs the account key can unwrap', async () => {
    const PORT = 48925
    const URL = normalizeRelayUrl(`ws://127.0.0.1:${PORT}`)
    const relay = startCaptureRelay(PORT)
    const pool = new SimplePool({ enableReconnect: true, enablePing: true })
    const sk = generateSecretKey()
    const pub = getPublicKey(sk)

    const notifier = startNotifier({ pool, secretKey: sk, dmRelays: () => [URL] })
    try {
      notifier.notify('send-ln', () => 'send: LN paid — 21 sats')
      await waitFor(() => relay.captured.length === 1)

      const wrap = relay.captured[0]!
      expect(wrap.kind).toBe(1059)
      // Gift wrap is signed by a throwaway key, addressed to ourselves.
      expect(wrap.pubkey).not.toBe(pub)
      expect(wrap.tags.find((t) => t[0] === 'p')?.[1]).toBe(pub)

      const rumor = unwrapEvent(wrap, sk)
      expect(rumor.kind).toBe(14)
      expect(rumor.pubkey).toBe(pub)
      expect(rumor.content).toBe('send: LN paid — 21 sats')
    } finally {
      notifier.stop()
      pool.close([URL])
      relay.stop()
    }
  })

  test('gate: no 10050 list → items dropped after grace, nothing published', async () => {
    const PORT = 48926
    const URL = normalizeRelayUrl(`ws://127.0.0.1:${PORT}`)
    const relay = startCaptureRelay(PORT)
    const pool = new SimplePool({ enableReconnect: true, enablePing: true })

    const notifier = startNotifier({
      pool,
      secretKey: generateSecretKey(),
      dmRelays: () => [],
      gateGraceMs: 50,
      gateRecheckMs: 10,
    })
    try {
      notifier.notify('health-boot', () => 'health: boot degraded')
      await waitFor(() => notifier.pendingCount() === 0)
      await sleep(100)
      expect(relay.captured.length).toBe(0)
    } finally {
      notifier.stop()
      pool.close([URL])
      relay.stop()
    }
  })

  test('grace window: 10050 resolving late still delivers queued items', async () => {
    const PORT = 48927
    const URL = normalizeRelayUrl(`ws://127.0.0.1:${PORT}`)
    const relay = startCaptureRelay(PORT)
    const pool = new SimplePool({ enableReconnect: true, enablePing: true })
    let relays: string[] = []

    const notifier = startNotifier({
      pool,
      secretKey: generateSecretKey(),
      dmRelays: () => relays,
      gateGraceMs: 2000,
      gateRecheckMs: 10,
    })
    try {
      notifier.notify('health-asp', () => 'health: proof sync failing')
      await sleep(50)
      expect(relay.captured.length).toBe(0)
      relays = [URL] // the outbox watcher resolves the 10050
      await waitFor(() => relay.captured.length === 1)
    } finally {
      notifier.stop()
      pool.close([URL])
      relay.stop()
    }
  })

  test('never throws: bad thunk, throwing relay source, later items still deliver', async () => {
    const PORT = 48928
    const URL = normalizeRelayUrl(`ws://127.0.0.1:${PORT}`)
    const relay = startCaptureRelay(PORT)
    const pool = new SimplePool({ enableReconnect: true, enablePing: true })
    let explode = true

    const notifier = startNotifier({
      pool,
      secretKey: generateSecretKey(),
      dmRelays: () => {
        if (explode) throw new Error('relay source down')
        return [URL]
      },
      gateGraceMs: 2000,
      gateRecheckMs: 10,
    })
    try {
      expect(() =>
        notifier.notify('refund', () => {
          throw new Error('broken template')
        }),
      ).not.toThrow()
      expect(notifier.pendingCount()).toBe(0)

      // dmRelays throwing is treated as "gate closed", not a crash …
      expect(() => notifier.notify('recv-ln', () => 'recv: 21 sats')).not.toThrow()
      await sleep(50)
      expect(relay.captured.length).toBe(0)
      // … and the same queued item delivers once the source heals.
      explode = false
      await waitFor(() => relay.captured.length === 1)
    } finally {
      notifier.stop()
      pool.close([URL])
      relay.stop()
    }
  })

  test('enabled() filters kinds; queue is bounded; stop() clears', async () => {
    const pool = new SimplePool({ enableReconnect: true, enablePing: true })
    // Gate closed with a long grace so items sit in the queue observably.
    const notifier = startNotifier({
      pool,
      secretKey: generateSecretKey(),
      dmRelays: () => [],
      enabled: (kind) => kind !== 'send-ln',
      gateRecheckMs: 50,
    })
    try {
      notifier.notify('send-ln', () => 'suppressed')
      expect(notifier.pendingCount()).toBe(0)

      for (let i = 0; i < 70; i++) notifier.notify('recv-ln', () => `msg ${i}`)
      expect(notifier.pendingCount()).toBe(64)

      notifier.stop()
      expect(notifier.pendingCount()).toBe(0)
      notifier.notify('recv-ln', () => 'after stop')
      expect(notifier.pendingCount()).toBe(0)
    } finally {
      notifier.stop()
    }
  })
})
