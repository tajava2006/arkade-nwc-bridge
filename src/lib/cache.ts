// SWR-style async cache. Holds the last successful value, dedupes
// in-flight fetches, and emits to listeners when fresh data lands.
//
// Used by the dashboard/send routes: hand back whatever we last had
// (instant render), then kick off a refresh in the background and push
// the new value over SSE when the upstream call returns. Avoids polling
// — fetches only fire when someone actually visits the page.

export interface CacheSnapshot<T> {
  value: T | null
  fetchedAt: number | null
  inFlight: boolean
}

export interface CacheUpdate<T> {
  value: T
  fetchedAt: number
}

export class AsyncCache<T> {
  private _value: T | null = null
  private _fetchedAt: number | null = null
  private _inFlight: Promise<T | null> | null = null
  private listeners = new Set<(u: CacheUpdate<T>) => void>()
  private readonly fetcher: () => Promise<T>
  private readonly minIntervalMs: number
  private readonly label: string

  constructor(args: {
    label: string
    fetcher: () => Promise<T>
    /**
     * If a refresh is requested less than this many ms after the last
     * successful fetch, the cached value is returned and no new fetch
     * fires. Defaults to 0 (always refresh on request).
     */
    minIntervalMs?: number
  }) {
    this.label = args.label
    this.fetcher = args.fetcher
    this.minIntervalMs = args.minIntervalMs ?? 0
  }

  snapshot(): CacheSnapshot<T> {
    return {
      value: this._value,
      fetchedAt: this._fetchedAt,
      inFlight: this._inFlight !== null,
    }
  }

  /**
   * Prime the cache with a value the caller already has in hand. Used
   * at boot when something fetched the upstream during init and we'd
   * rather not pay the round-trip again on first page visit. Does not
   * fire listeners — they're for *changes*, not initial population.
   */
  seed(value: T): void {
    this._value = value
    this._fetchedAt = Date.now()
  }

  /**
   * Trigger a refresh. If one is already in flight, returns that
   * promise so concurrent callers share a single upstream request.
   * If a fetch just finished within minIntervalMs, no new fetch
   * fires — useful for back-to-back page visits.
   *
   * Errors are logged and swallowed so a failed upstream doesn't
   * propagate into request handlers that fire-and-forget. The cache
   * keeps its previous value; next refresh attempt may succeed.
   */
  refresh(): Promise<T | null> {
    if (this._inFlight) return this._inFlight
    if (
      this._fetchedAt !== null &&
      this.minIntervalMs > 0 &&
      Date.now() - this._fetchedAt < this.minIntervalMs
    ) {
      return Promise.resolve(this._value)
    }
    const p = this.fetcher()
      .then((v) => {
        this._value = v
        this._fetchedAt = Date.now()
        const update: CacheUpdate<T> = { value: v, fetchedAt: this._fetchedAt }
        for (const l of this.listeners) {
          try {
            l(update)
          } catch (err) {
            console.error(`cache(${this.label}): listener crashed:`, err)
          }
        }
        return v
      })
      .catch((err) => {
        console.error(`cache(${this.label}): refresh failed:`, err)
        return null
      })
      .finally(() => {
        this._inFlight = null
      })
    this._inFlight = p
    return p
  }

  onUpdate(fn: (u: CacheUpdate<T>) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}
