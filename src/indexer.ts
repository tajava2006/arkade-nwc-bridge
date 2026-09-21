import { RestIndexerProvider, type VirtualCoin } from '@arkade-os/sdk'

// The SDK's vtxo pager decides "that was the last page" by comparing the row
// count it got back to the page size it ASKED for:
//
//   hasMore = page ? vtxos.length === pageSize : false   // DEFAULT_PAGE_SIZE = 500
//
// That is only sound if the server never returns a smaller page than requested.
// arkd stopped honouring that in v0.9.16 ("Fix pagination overflow", #35), which
// added the clamp `params.PageSize > maxSize` -> maxSize, and maxSize for vtxos
// is 100. So the SDK asks for 500, arkd silently serves 100, `100 === 500` is
// false, and the loop concludes it has the whole set after page 1. Pages 2..N
// are never read. There is no error, no warning — the wallet simply believes it
// owns less than it does.
//
// arkd sorts newest-first (vtxo_repo.go SelectVtxosWithPubkeys), so what falls
// off the end is always the OLDEST rows — which is exactly the set nearest to
// expiry, and the set a refresh most needs to see. And because the sync query
// carries no filter, spent rows (tombstones) crowd the live ones out: 222 of our
// 228 rows were already spent.
//
// Observed mainnet 2026-09-21: 228 rows, 3 pages, only page 1 ever read. Three
// sub-dust vtxos (869 sats, created 09-01) dropped out of /send, out of the
// balance, out of settle()'s input set — so consolidate-all silently stopped
// being "all" — and the exit vault quarantined them as "the ASP dropped them".
// arkd had them the whole time, unspent and round-redeemable.
//
// Still present in 0.4.74 (latest) and 0.5.0-rc.9, byte for byte, and the SDK
// version is pinned by @arkade-os/boltz-swap anyway — so upgrading is not a fix.
// We cannot change the SDK's loop, so we make it a no-op instead: answer the
// whole set in one call and hand back no page object, which ends the loop after
// our single complete answer (`page ? … : false`).
//
// Omitting the page parameters entirely is what gets us the whole set: arkd's
// `paginate` short-circuits on `params == nil` and returns every item uncapped.
// Same trick, and the same reason, as fetchChain in exit/proof_sync.ts — one
// request means one walk, so there are no independent slices to stitch and no
// F22-shaped hole to open.

/** `RestIndexerProvider.getVtxos`'s own option/result types (not exported by name). */
type GetVtxosOpts = Parameters<RestIndexerProvider['getVtxos']>[0]
type GetVtxosResult = Awaited<ReturnType<RestIndexerProvider['getVtxos']>>

/** arkd's own cap for vtxo pages — only used on the degraded walk below. */
const WALK_PAGE_SIZE = 100
/** Bound on the degraded walk, so a surprising `total` can never spin forever. */
const WALK_MAX_PAGES = 500

function outpointKey(v: VirtualCoin): string {
  return `${v.txid}:${v.vout}`
}

/** Drop the caller's pagination so arkd takes its uncapped path. */
function withoutPaging(opts?: GetVtxosOpts): GetVtxosOpts | undefined {
  if (!opts) return opts
  const { pageIndex: _pageIndex, pageSize: _pageSize, ...rest } = opts
  return rest as GetVtxosOpts
}

/** One page fetch, as {@link fetchWholeVtxoSet} needs it. */
export type VtxoPageFetcher = (opts?: GetVtxosOpts) => Promise<GetVtxosResult>

/**
 * Ask `fetchPage` for the COMPLETE vtxo set, and report no page — so the SDK's
 * pager (`hasMore = page ? … : false`) runs exactly once over a whole answer.
 *
 * Pure apart from `fetchPage`, so the paging contract is unit-testable without
 * a server.
 */
export async function fetchWholeVtxoSet(
  fetchPage: VtxoPageFetcher,
  opts?: GetVtxosOpts,
): Promise<GetVtxosResult> {
  const base = withoutPaging(opts)
  const whole = await fetchPage(base)

  // `total > 1` means arkd paginated a request that carried no page parameters
  // — the assumption above no longer holds. Fall back to walking it, but say
  // so: the lesson of this bug is that a truncated vtxo set must never again
  // fail quietly.
  if (base && whole.page && whole.page.total > 1) {
    console.warn(
      `indexer: arkd paginated an unpaged vtxo query (${whole.page.total} pages) — ` +
        `walking every page. The single-request path is no longer available; ` +
        `pages come from separate walks now, so a row missing from all of them ` +
        `would be invisible here (see exit/proof_sync.ts fetchChain, F22).`,
    )
    return { vtxos: await walkEveryPage(fetchPage, base, whole.vtxos), page: undefined }
  }

  return { vtxos: whole.vtxos, page: undefined }
}

/**
 * Degraded path: page explicitly and union the results by outpoint.
 *
 * arkd's page numbers are 1-BASED and it normalises `PageNum <= 0` to 1, so
 * index 0 and index 1 are the same page (measured against the live server) —
 * starting at 1 is what makes page 2 reachable at all. Termination reads arkd's
 * own `total` rather than a row count, because a row count is the very thing
 * that lied here.
 */
async function walkEveryPage(
  fetchPage: VtxoPageFetcher,
  base: NonNullable<GetVtxosOpts>,
  seed: VirtualCoin[],
): Promise<VirtualCoin[]> {
  const byOutpoint = new Map<string, VirtualCoin>()
  for (const v of seed) byOutpoint.set(outpointKey(v), v)

  for (let pageIndex = 1; pageIndex <= WALK_MAX_PAGES; pageIndex++) {
    const res = await fetchPage({ ...base, pageIndex, pageSize: WALK_PAGE_SIZE })
    for (const v of res.vtxos) byOutpoint.set(outpointKey(v), v)
    if (pageIndex >= (res.page?.total ?? 1)) return [...byOutpoint.values()]
  }

  throw new Error(
    `indexer: vtxo paging did not terminate within ${WALK_MAX_PAGES} pages — ` +
      `refusing to report a set that may be incomplete`,
  )
}

/**
 * A {@link RestIndexerProvider} whose `getVtxos` always answers the COMPLETE
 * set, and never reports a page (so the SDK's broken pager runs exactly once).
 *
 * Use this everywhere instead of `RestIndexerProvider` — including as
 * `Wallet.create({ indexerProvider })`, which is the one that matters: the
 * wallet's vtxo snapshot, its balance, settle()'s input selection and the exit
 * vault's live set are all downstream of that single instance.
 */
export class WholeSetIndexerProvider extends RestIndexerProvider {
  override getVtxos(opts?: GetVtxosOpts): Promise<GetVtxosResult> {
    return fetchWholeVtxoSet((o) => super.getVtxos(o), opts)
  }
}
