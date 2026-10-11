import { expect, test } from 'bun:test'

import { PingableWebSocket } from '../../src/nostr/ping_ws'

// nostr-tools picks its keepalive by feature-detecting `ws.ping && ws.once`.
// Losing either silently puts the bridge back on the dummy-REQ fallback,
// which closes the socket of any relay that does not answer REQs with EOSE.
test('PingableWebSocket satisfies nostr-tools ping detection and gets a pong', async () => {
  const server = Bun.serve({
    port: 48921,
    fetch(req, s) {
      return s.upgrade(req) ? (undefined as unknown as Response) : new Response('ws only')
    },
    websocket: { message() {} },
  })
  const ws = new PingableWebSocket('ws://127.0.0.1:48921')
  expect(typeof ws.ping).toBe('function')
  expect(typeof ws.once).toBe('function')
  await new Promise<void>((r) => ws.addEventListener('open', () => r(), { once: true }))
  const pong = new Promise<boolean>((r) => {
    ws.once('pong', () => r(true))
    setTimeout(() => r(false), 2000)
  })
  ws.ping()
  expect(await pong).toBe(true)
  ws.close()
  server.stop(true)
})
