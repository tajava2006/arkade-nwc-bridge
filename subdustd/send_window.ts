// Per-invoice sizing of T, the atomic sub-dust send's refund locktime
// (ATOMIC_SUBDUST_PLAN.md §12).
//
// T used to be a flat `subdustSendWindow` (then 72h) for every invoice,
// because T is also the LN cltv budget: sendFund pays with
// `cltvLimit = (T − payMargin) / blockTime`, so a small T fails long routes.
// The price was paid by the funder — until the cooperative cancel (§11) landed,
// a failed send locked the funding vtxo for the whole window, and the funding
// is spent WHOLE.
//
// The cost is not gone, just smaller: T still bounds how long a swap can sit
// unresolved when the server is unreachable and the funder must fall back to the
// CLTV refund, and a bigger T also narrows funding eligibility (an input's
// batch must outlast T + margin, so a 72h window makes the last 3 days of a
// 7-day batch unusable). Sizing T from the route the payment will actually take
// gives back both, and costs one graph query — no HTLC, no network hop.

export interface SendWindowConfig {
  /** Configured ceiling (`subdust.sendWindowSecs`, seconds). Never exceeded. */
  sendWindow: number
  /** Seconds before T after which no new LN pay starts. */
  payMargin: number
  /** Seconds per block for the cltv ⇄ time conversion. */
  blockTime: number
}

/**
 * Headroom in blocks over the route we measured at init. The route that
 * `sendFund` actually pays over can be longer than the one queried moments
 * earlier (mission control moves, channels change), and a T that is too tight
 * turns into a `cltvLimit` the payment cannot satisfy. 36 blocks is ~6h of
 * slack while still leaving a typical 100–200 block route far under the 72h
 * ceiling.
 */
export const SUBDUST_SEND_CLTV_BUFFER_BLOCKS = 36

/**
 * Never mint a T so small that the swap is unresolvable in practice. Only binds
 * on degenerate route answers — a real route plus the buffer clears it easily.
 */
export const SUBDUST_SEND_MIN_WINDOW_SECS = 3600

/**
 * Seconds to add to now for this swap's T.
 *
 * `routeCltvDelta` is the relative CLTV (blocks) the measured route needs, or
 * `undefined` when we could not measure it — no route found, LND unreachable,
 * a nonsense answer. **Unknown falls back to the full configured window**, the
 * pre-existing behaviour: a route query is an optimisation, never a gate. It
 * deliberately does NOT reject the swap, because the underlying query reports
 * "no route" and "query failed" the same way, and refusing a send because LND
 * hiccuped is worse than letting it fail fast and unwind (§11).
 */
export const sendWindowSecs = (
  routeCltvDelta: number | undefined,
  cfg: SendWindowConfig,
): number => {
  if (routeCltvDelta === undefined || routeCltvDelta <= 0) {
    return cfg.sendWindow
  }
  const needed =
    (routeCltvDelta + SUBDUST_SEND_CLTV_BUFFER_BLOCKS) * cfg.blockTime +
    cfg.payMargin
  return Math.min(
    cfg.sendWindow,
    Math.max(SUBDUST_SEND_MIN_WINDOW_SECS, Math.ceil(needed)),
  )
}

/**
 * The cltv ceiling handed to `queryRoutes`, so it never proposes a route that
 * the configured window could not honour anyway. Mirrors sendFund's own
 * `cltvLimit` derivation at the maximum T.
 */
export const maxCltvBlocks = (cfg: SendWindowConfig): number =>
  Math.max(1, Math.floor((cfg.sendWindow - cfg.payMargin) / cfg.blockTime))
