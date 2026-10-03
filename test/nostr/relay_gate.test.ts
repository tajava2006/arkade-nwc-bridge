import { describe, expect, test } from 'bun:test'
import type { SimplePool } from 'nostr-tools/pool'

import { createRelayGate } from '../../src/nostr/relay_gate'

const URL = 'wss://relay.example/'

// The gate only reads the pool's status map and calls ensureRelay.
function harness(opts: { ensure?: () => Promise<void> } = {}) {
  let clock = 1_000_000
  const connected = new Set<string>()
  let attempts = 0
  const pool = {
    listConnectionStatus: () => new Map([...connected].map((u) => [u, true] as const)),
    ensureRelay: async () => {
      attempts++
      await (opts.ensure ?? (async () => {}))()
    },
  } as unknown as SimplePool
  const gate = createRelayGate({ pool, now: () => clock, random: () => 0.5, log: () => {} })
  return {
    gate,
    connected,
    advance: (ms: number) => {
      clock += ms
    },
    attempts: () => attempts,
  }
}

describe('relay gate', () => {
  test('an unknown relay is allowed straight away', () => {
    const h = harness()
    expect(h.gate.allow(URL)).toBe(true)
    expect(h.gate.retryInMs(URL)).toBe(0)
  })

  test('failures back off 5s, 10s, 20s … and cap at 5 minutes', () => {
    const h = harness()
    const waits: number[] = []
    for (let i = 0; i < 9; i++) {
      h.gate.failed(URL)
      expect(h.gate.allow(URL)).toBe(false)
      const wait = h.gate.retryInMs(URL)
      waits.push(wait)
      h.advance(wait)
      expect(h.gate.allow(URL)).toBe(true)
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000])
  })

  test('every joiner of one failed attempt reporting it counts once', () => {
    const h = harness()
    for (let i = 0; i < 10; i++) h.gate.failed(URL)
    expect(h.gate.retryInMs(URL)).toBe(5_000)
  })

  test('the pool form and the WHATWG form of a URL share one state', () => {
    const h = harness()
    h.gate.failed('wss://relay.example')
    expect(h.gate.allow('wss://relay.example/')).toBe(false)
  })

  test('a connected relay is always allowed, even mid-backoff', () => {
    const h = harness()
    h.gate.failed(URL)
    h.connected.add(URL)
    expect(h.gate.allow(URL)).toBe(true)
  })

  test('a connection that held a minute clears the history', () => {
    const h = harness()
    for (let i = 0; i < 4; i++) {
      h.gate.failed(URL)
      h.advance(h.gate.retryInMs(URL))
    }
    h.connected.add(URL)
    h.gate.succeeded(URL)
    h.advance(60_000)
    h.connected.delete(URL)
    // Dropped after a healthy run: retry at once, and start over at 5s.
    expect(h.gate.allow(URL)).toBe(true)
    h.gate.failed(URL)
    expect(h.gate.retryInMs(URL)).toBe(5_000)
  })

  test('connect-then-kick keeps escalating instead of resetting', () => {
    const h = harness()
    const waits: number[] = []
    for (let i = 0; i < 4; i++) {
      h.connected.add(URL)
      h.gate.succeeded(URL)
      h.advance(1_000)
      h.connected.delete(URL)
      expect(h.gate.allow(URL)).toBe(false)
      waits.push(h.gate.retryInMs(URL))
      h.advance(h.gate.retryInMs(URL))
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000])
  })

  test('ensure() makes no attempt while backing off and never rejects', async () => {
    const h = harness({
      ensure: async () => {
        throw new Error('connection failed')
      },
    })
    expect(await h.gate.ensure(URL)).toBe(false)
    expect(h.attempts()).toBe(1)
    expect(await h.gate.ensure(URL)).toBe(false)
    expect(h.attempts()).toBe(1)
    h.advance(5_000)
    expect(await h.gate.ensure(URL)).toBe(false)
    expect(h.attempts()).toBe(2)
    expect(h.gate.retryInMs(URL)).toBe(10_000)
  })
})
