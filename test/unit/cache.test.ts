import { describe, expect, test } from 'bun:test'
import { AsyncCache } from '../../src/lib/cache'

// The SWR cache behind the dashboard/send routes. Its promises — dedupe,
// min-interval suppression, error swallowing with value retention — fail
// SILENTLY when broken (pages just go stale or hammer upstream), so they
// get pinned here.

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AsyncCache', () => {
  test('concurrent refreshes share one upstream fetch', async () => {
    let calls = 0
    const gate = deferred<number>()
    const cache = new AsyncCache({
      label: 't',
      fetcher: () => {
        calls++
        return gate.promise
      },
    })

    const a = cache.refresh()
    const b = cache.refresh() // lands while the first is in flight
    expect(cache.snapshot().inFlight).toBe(true)

    gate.resolve(42)
    expect(await a).toBe(42)
    expect(await b).toBe(42)
    expect(calls).toBe(1) // deduped
    expect(cache.snapshot()).toMatchObject({ value: 42, inFlight: false })
  })

  test('minIntervalMs suppresses back-to-back refetches, then allows again', async () => {
    let calls = 0
    const cache = new AsyncCache({
      label: 't',
      fetcher: async () => ++calls,
      minIntervalMs: 30,
    })

    expect(await cache.refresh()).toBe(1)
    expect(await cache.refresh()).toBe(1) // within the window — cached value, no fetch
    expect(calls).toBe(1)

    await new Promise((r) => setTimeout(r, 40))
    expect(await cache.refresh()).toBe(2) // window elapsed — refetch
  })

  test('a failed refresh keeps the previous value and does not throw', async () => {
    let fail = false
    const cache = new AsyncCache({
      label: 't',
      fetcher: async () => {
        if (fail) throw new Error('upstream down')
        return 'good'
      },
    })
    await cache.refresh()
    fail = true
    expect(await cache.refresh()).toBeNull() // swallowed, signalled as null
    expect(cache.snapshot().value).toBe('good') // stale beats gone
    fail = false
    expect(await cache.refresh()).toBe('good') // in-flight cleared — recovers
  })

  test('listeners fire on fresh data, not on seed; a crashing listener is isolated', async () => {
    const cache = new AsyncCache({ label: 't', fetcher: async () => 'fresh' })
    const seen: string[] = []
    cache.onUpdate(() => {
      throw new Error('bad listener')
    })
    const off = cache.onUpdate((u) => seen.push(u.value))

    cache.seed('seeded')
    expect(seen).toEqual([]) // seed is initial population, not a change

    await cache.refresh()
    expect(seen).toEqual(['fresh']) // delivered despite the crashing sibling

    off()
    await cache.refresh()
    expect(seen).toEqual(['fresh']) // unsubscribed
  })
})
