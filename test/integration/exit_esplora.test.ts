import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { pickEsplora } from '../../src/exit/esplora'

// 127.0.0.1:1 — nothing listens there, connect refuses immediately, so the
// "dead candidate" cases don't wait out the probe timeout.
const DEAD = 'http://127.0.0.1:1'

describe('pickEsplora', () => {
  let server: ReturnType<typeof Bun.serve>
  let liveUrl: string

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api/blocks/tip/height') return new Response('956634')
        return new Response('not found', { status: 404 })
      },
    })
    liveUrl = `http://127.0.0.1:${server.port}/api`
  })

  afterAll(() => {
    server.stop(true)
  })

  test('keeps priority order when the first candidate answers', async () => {
    const picked = await pickEsplora([liveUrl, `${DEAD}/api`], 1_500)
    expect(picked.url).toBe(liveUrl)
    expect(picked.healthy).toBe(true)
  })

  test('skips a dead candidate and takes the next healthy one', async () => {
    const picked = await pickEsplora([`${DEAD}/api`, liveUrl], 1_500)
    expect(picked.url).toBe(liveUrl)
    expect(picked.healthy).toBe(true)
  })

  test('all dead → first candidate, flagged unhealthy', async () => {
    const picked = await pickEsplora([`${DEAD}/a`, `${DEAD}/b`], 800)
    expect(picked.url).toBe(`${DEAD}/a`)
    expect(picked.healthy).toBe(false)
  })

  test('empty list is a programming error', async () => {
    expect(pickEsplora([])).rejects.toThrow('esploraUrls must not be empty')
  })
})
