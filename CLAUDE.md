# CLAUDE.md

You are working on **arkade-nwc-bridge**, a single-process Bun
service that exposes an Ark-Protocol-backed Lightning wallet over
[NIP-47 (Nostr Wallet Connect)](https://github.com/nostr-protocol/nips/blob/master/47.md).
Read [`DESIGN.md`](DESIGN.md) for the *why* (architecture decisions,
schema rationale, footguns); this file is just the orientation.

## Project shape

```
src/
  defaults.ts                — static config (network, ASP, http bind/port,
                               db path) + OUTBOX_FALLBACK_PUBKEY,
                               OUTBOX_BOOTSTRAP_RELAYS, NWC_RELAYS_FALLBACK.
                               No env vars
  config.ts                  — thin wrapper over defaults (no relay list —
                               the outbox watcher owns that now)
  account.ts                 — accounts table CRUD (loadAccount /
                               createAccount / parseNsecInput / generate)
  server_config.ts           — bridge_server single-row CRUD +
                               resolveServerSet (config.json > row >
                               defaults) + validateServerSet. The fresh-
                               start ark/boltz choice, then immutable
  db.ts                      — bun:sqlite + WAL + append-only MIGRATIONS
  history.ts                 — unified wallet-history ledger (HISTORY_DESIGN.md):
                               one row per money event on every rail; mirrored
                               kinds (nwc_ln ← transactions, offboard ←
                               offboards) re-synced wholesale by
                               syncHistoryFromSources, keyset pagination on
                               (created_at, id) for /history
  boarding_history.ts        — onchain-deposit watcher, RECORDING only (the
                               SDK's VtxoManager does the actual boarding
                               auto-settle): getBoardingUtxos delta on a 60s
                               interval, boarding_seen watermark (first pass
                               baselines — no backfill), own-boarding-input
                               sweep suppression, esplora-confirmed settles
  wallet.ts                  — privateKey → SingleKey → Wallet (in-memory repos)
  boltz.ts                   — ArkadeSwaps + SqliteSwapRepository,
                               SwapManager auto-claim/refund + listener +
                               boot-time reconcile for incoming swaps
  boltz_repository.ts        — SqliteSwapRepository: rows keyed on swap.id,
                               full BoltzSwap stashed as JSON blob
  exit/                      — unilateral exit (EXIT_DESIGN.md). ASP-free:
                               vault.ts (offline proof store — exit_proof_txs
                               + exit_vtxos incl. quarantine), proof_sync.ts +
                               sync_service.ts (mirror proofs while the ASP is
                               alive; GC is evidence-gated), evidence.ts
                               (classify a disappearance: verified spend by
                               OUR key / settlement absorption via value
                               conservation (no-forfeit sub-dust refresh) /
                               local expiry / unproven→quarantine),
                               esplora.ts (pickEsplora),
                               vault_indexer.ts (serve Unroll.Session offline),
                               csv.ts (CSV-elapsed judgment), estimate.ts
                               (offline exit cost), engine.ts + ops.ts (drive
                               the session, exit_ops table, sweep, funding),
                               boost.ts + broadcasts.ts (stuck-package fee
                               re-boost: replace the CPFP child via RBF and
                               resubmit the package; sweep RBF; tip height at
                               broadcast for "waiting N blocks"),
                               chain_order.ts (spends-DAG layout for display —
                               arkd's BFS array stays Session's input),
                               stepper.ts (per-vtxo DAG model: DB-only build +
                               one-tx-at-a-time status probes),
                               dest.ts + dest_verify.ts + final_send.ts
                               (final send: challenge-verified destination —
                               BIP-322/legacy signature proof of control,
                               exit_dest table — then an exact-fee no-change
                               send-all of the fuel P2TR, RBF-boostable)
  atomic/boltz_ws.ts         — push channel for sub-dust swaps: subscribes
                               the fork's swap.update ws (sidecar) by swap id
                               and pokes the reconciler on transitions. Pure
                               accelerator — the 30s reconciler stays the
                               backstop; dead endpoint degrades to polling.
                               URL: config.boltzWsUrl > derived
                               ws(s)://host/v2/ws — the SDK's own single-host
                               path-split convention, already served by both
                               the VPS nginx and the compose boltz-proxy, so
                               no deployment needs to set anything
  polyfills.ts               — @noble/curves + @scure/btc-signer ESM warming
                               (bun async-ESM require trap) + EventSource shim
  index.ts                   — three-mode boot (setup / ready / degraded);
                               owns the shared SimplePool + relay-status
                               dispatch + 5s ensureRelay watchdog + the exit
                               engine + proof-sync; SIGINT/SIGTERM teardown
  nostr/
    connections.ts           — connections table CRUD + URI builder;
                               Connection.relays persisted per row
    crypto.ts                — nip44_v2 / nip04 (request encryption tag
                               picks; default nip04 per NIP-47 legacy rule)
    outbox.ts                — NIP-65 watcher: over OUTBOX_BOOTSTRAP_RELAYS,
                               two separate kind-10002 subs — the account
                               key (primary, via setPrimaryPubkey once it
                               exists) and OUTBOX_FALLBACK_PUBKEY (operator).
                               Active set = user > operator > NWC_RELAYS_FALLBACK
                               (getOutboxSource reports which); exposes that +
                               bootstrap / outbox relay status snapshots.
                               Also watches the primary key's kind-10050 DM
                               relay list (getDmRelays/hasDmRelayList) — the
                               notifier's gate + publish targets; never feeds
                               the NWC relay set
    notifier.ts              — NIP-17 self-DM operational notifications:
                               notify(kind, buildThunk) enqueues, a single
                               drain loop gift-wraps (nip17.wrapEvent, to our
                               own npub) and publishes to the 10050 relays.
                               Never throws, never awaited by callers; no
                               10050 ⇒ items gate-dropped after a 30s grace.
                               NOTIFY_KINDS is the per-category toggle seam
                               (all on today; `enabled` dep for a future
                               settings surface). Hook sites thread the
                               stable `notify` forwarder from index.ts
    publish.ts               — shared best-effort publishToRelays (allSettled,
                               per-relay warn, never throws)
    persistent_sub.ts        — self-healing subscription wrapper: one
                               sub per relay, re-issues the REQ when
                               nostr-tools permanently kills a socket's
                               subs (initial-connect failure; mid-outage
                               reconnects are healed upstream since
                               nostr-tools 2.23.9, our #538 fix);
                               cross-relay event dedupe via alreadyHaveEvent
    service.ts               — takes the shared SimplePool, one SubCloser
                               per connection over conn.relays;
                               registerConnection/unregisterConnection for
                               live (un)subscription on web mutations
  handlers/
    get_info.ts              — capabilities; no notifications advertised
    get_balance.ts           — (available + recoverable) × 1000 msat
    make_invoice.ts          — invoice via the shared LN-receive core
                               (ln_receive.ts, same core as the CLINK noffer:
                               reverse swap ≥ dust; sub-dust <330 → ATOMIC
                               receive, issueAtomicReceive + driveAtomicReceives
                               reconciler, see atomic_receive.ts / ATOMIC_SUBDUST_PLAN.md)
    pay_invoice.ts           — submarine swap one-shot; amount stays the
                               invoice nominal, fees_paid = our cost
                               (+ sub-dust <330 → ATOMIC send, atomicSubdustSend, see ln_send.ts)
    lookup_invoice.ts        — connection-scoped SELECT
    list_transactions.ts     — connection-scoped, from/until/limit/offset
  lib/
    descriptor.ts            — Bitcoin Core descriptor checksum (show-btc-key)
    budget.ts                — budget renewal windows (computed from
                               (renewal, now), never stored) + cycleSpentMsat
                               ('never' reads the spent_msat counter,
                               periodic sums transactions in-window)
    cache.ts                 — AsyncCache: SWR with dedupe + debounce + listeners
    errors.ts                — NwcError + NIP-47 error code union
    html.ts                  — auto-escaping tagged-template HTML + raw()
    methods.ts               — SUPPORTED_METHODS (info event + dispatch)
    msat.ts                  — sat ↔ msat with exact-multiple check
    relay_status.ts          — RelayStatus type + outbox-panel /
                               per-connection fragment renderers
    sse.ts                   — SseHub: tracks open browser SSE streams,
                               sendTo / broadcast / ping / closeAll
    transaction.ts           — TransactionRow + NIP-47 mapping
  web/
    server.ts                — Bun.serve routes; AppState (setup|ready|
                               degraded) carries wallet/swaps/nostr/caches +
                               exitEngine/proofSync; /events opens an SSE
                               stream per browser tab; loopback only
    qr.ts                    — `qr` package wrapper (SVG)
    views/                   — server-rendered pages incl. setup.ts,
                               degraded.ts, exit.ts + exit_detail.ts;
                               layout.ts injects the SSE client JS
scripts/
  show-nsec.ts               — recovery: print npub/nsec from sqlite
  show-btc-key.ts            — recovery: same key as WIF + tr() descriptor
                               (checksummed via lib/descriptor.ts) for import
                               into any descriptor wallet
data/                        — sqlite file (gitignored)
```

## Dev commands

```bash
bun run dev            # bun --hot run src/index.ts
bun run start          # plain run
bun run typecheck      # tsc --noEmit
```

The web UI lives at http://127.0.0.1:4282 by default. First-run
flow: open `/setup` to paste or generate an nsec; the bridge stays
in setup-mode (all other routes redirect there) until the account
row exists. Logs go to stdout; when running in background pipe to
`/tmp/bridge.log` for `tail`-friendly debugging.

## Conventions

- **Mainnet, alpha SDKs.** Treat every change as production-adjacent;
  small-amount testing yes, but no "let me try something weird"
  against real funds without explicit user approval.
- **Migrations are append-only** ([`src/db.ts`](src/db.ts)). Never
  edit a shipped migration's SQL — bump the version and write a
  correction.
- **Don't auto-commit.** Wait for the user to ask. Cross-repo
  preference; if you're unsure, summarize the diff and ask.
- **Comments capture *why* the non-obvious thing.** Names already
  carry *what*. Don't restate the obvious or reference the current
  PR/issue.
- **NWC error codes:** throw `NwcError` from handlers; the nostr
  service maps it to NIP-47's error envelope. Unwrapped errors
  become `INTERNAL` — fine as a fallback but prefer specificity.
- **Publishing is best-effort.** Use `publishToRelays` in
  [`src/nostr/publish.ts`](src/nostr/publish.ts), never raw
  `Promise.all(pool.publish(...))` — a single timing-out relay
  must not crash the bridge.
- **Notifier hooks must stay fire-and-forget.** Every operator-DM call
  is `notify?.(kind, () => \`...\`)` placed AFTER an existing state
  transition succeeds; the thunk runs inside the notifier's try/catch,
  so hook sites never add throw/await risk to a money path. Any db
  read that decides WHETHER to notify gets its own try/catch (see the
  recv gates). Don't notify from two places for one event — each event
  has one owning site (see the kind comments in notifier.ts).
- **Web → Nostr direction only.** Web calls
  `NostrService.registerConnection` / `unregisterConnection` via
  its narrow interface. Don't reach into pool/handler internals
  from web code.
- **Shared SimplePool.** `index.ts` constructs `new SimplePool({
  enableReconnect: true, enablePing: true })` and hands it to both
  the outbox watcher and the nostr service. Don't construct a
  second pool in a subsystem — `listConnectionStatus` must stay the
  single source of truth, otherwise the outbox panel and
  per-connection rows can disagree on whether a relay is up.
- **Connection isolation.** `lookup_invoice` / `list_transactions`
  MUST filter on `connection_id` — a client can only see its own
  activity. The operator-facing /history page reads the separate
  `history` ledger instead (HISTORY_DESIGN.md); never widen
  `transactions` with non-NWC rows — its NOT-NULL connection FK and
  `incoming|outgoing` type vocabulary are what keep NIP-47 responses
  clean. (`wallet.getTransactionHistory()` stays banned: full recompute
  per call, no pagination — the old ark-side tab was removed for that.)
- **Live UI = SSE fragments.** Pool callbacks fire in `index.ts` and
  dispatch named events through `SseHub` (`outbox-update`,
  `connection-update`, `balance-status`). Layout
  JS swaps `innerHTML` on `[data-outbox-panel]` /
  `[data-connection-relay-summary="<id>"]` /
  `[data-connection-relay-detail="<id>"]` /  `[data-balance]`.
  Pre-rendered HTML on the server keeps the
  client script ~20 lines; no client-side templating.

## Hot footguns

- **No env vars.** Static defaults live in [`src/defaults.ts`](src/defaults.ts);
  the nsec lives in the `accounts` sqlite table and the chosen ark/boltz
  pair in the single-row `bridge_server` table — both written at `/setup`.
  Don't reintroduce `.env` parsing — it was deliberately removed so the
  bridge is "clone + `bun run dev`" with no setup ritual. The one
  opt-in override is `./data/config.json` (loaded by
  [`src/config.ts`](src/config.ts)) for the docker deployment case —
  any `Config` field present overrides the matching default, missing
  fields fall through. For **ark/boltz specifically** the runtime value is
  `resolveServerSet` ([`src/server_config.ts`](src/server_config.ts)):
  `data/config.json` > `bridge_server` row > defaults, so a docker/regtest
  config.json still wins over the fresh-start row. The file is intentionally
  absent from a fresh clone; don't add it to defaults or examples checked
  into the repo.
- **Two-phase boot.** [`src/index.ts`](src/index.ts) starts the web
  server first, then either calls `bootReady` immediately (account
  exists) or waits for POST `/setup` to call it. Don't reorder this
  to "wallet first" — there's no nsec (nor a chosen ark/boltz) to hand
  the wallet until setup completes. `bootReady` resolves ark/boltz from
  the `bridge_server` row at entry (not at process start — the row
  doesn't exist yet on a fresh boot) and stamps them into the ready
  AppState; POST `/setup` validates then writes the row + account
  together and rolls BOTH back on bring-up failure. AppState lives in
  [`src/web/server.ts`](src/web/server.ts).
- **Reference clones live one level up** in the operator workspace's
  `reference/` (`../nips/`, `../luds/`, `../lightning-address/`,
  `../nostr-tools/`, `../ts-sdk/`, `../wallet/`, `../arkd/`, …) — they
  were consolidated there so they're not duplicated per-app. They're
  gitignored convenience clones for reading source only; nothing here
  imports from them (the `nostr-tools/...` imports are the npm package).
  One soft dependency: `regtest-e2e/env.sh` will *reuse* a sibling
  `../ts-sdk/regtest` checkout of arkade-regtest to avoid a duplicate
  clone — but the repo is standalone regardless, via its own
  `regtest-e2e/arkade-regtest` submodule (auto-inited on first drill).
  Don't link to them from anything that gets committed — public links
  will 404. External URLs are in [DESIGN.md §10](DESIGN.md). Refresh
  them via the workspace's `update-refs.sh`, not a bridge npm script.
- **The ark dependency chain must stay a single instance.**
  `@arkade-os/boltz-swap` pins `@arkade-os/sdk` to an *exact* version,
  and that SDK in turn pins `@noble/curves` / `@scure/base` /
  `@scure/btc-signer` exactly. Running ahead of those pins puts two
  copies of the same library in the tree: `tsc` rejects it outright
  (`Wallet` vs `IWallet`, "separate declarations of a private property"),
  and the failure mode where it *doesn't* is worse — two `Transaction`
  classes on a money path. The `overrides` block in package.json is what
  holds the line; `./update-deps.sh` prints boltz-swap's required SDK
  next to the override so a drift is visible. Bump those four by hand
  only when boltz-swap bumps its own pin.
- **Boltz endpoint is *not* `api.ark.boltz.exchange`.** The d.ts
  docstring lies; the real SDK default is `api.boltz.exchange` and
  that's what the production wallet uses. Don't pass `swapProvider`
  explicitly unless someone has a specific reason.
- **`transactions.amount_msat` = the BOLT11 nominal, both
  directions; `fees_paid_msat` = our cost.** Wallet movement is
  derived (incoming credits amount − fees, outgoing debits
  amount + fees), never stored — storing it double-shows the fee
  in clients that render amount and fee side by side, and NIP-57
  receipt validation requires the bolt11 amount to equal the zap
  request's (a 21-sat zap must read 21). Invoices are never
  inflated: the swap cut comes out of what lands on Ark — the
  receiver's cost, not the payer's. Mind the SDK trap here:
  `createLightningInvoice` result.amount is the **post-fee on-Ark
  amount** (what lands), NOT the invoice nominal — don't record it
  as `amount`. Rationale: DESIGN.md §5 "Amount semantics".
- **`recoverable` balance is sub-dust VTXOs, not "broken funds".**
  Include it in `get_balance` responses.
- **One subscription per connection, on `conn.relays`.** Each
  connection has its own relay set (`relays_json` column), baked
  from the outbox watcher at create time. A
  single multi-pubkey filter would create a race window on revoke;
  per-connection SubCloser map makes revoke O(1) Map.delete with
  no race. Outbox updates affect *new* connections only — existing
  ones keep their relays for life, even if the operator's NIP-65
  list changes underneath. `cfg.nwcRelays` doesn't exist.
- **`enableReconnect` still gives up on the *initial* connect — and
  takes the subs with it.** Since nostr-tools 2.23.9 (our upstream
  fix, nbd-wtf/nostr-tools#538) a failed *retry* no longer sets
  `skipReconnection=true`: mid-outage reconnects keep backing off
  (last backoff entry repeats) and every sub re-REQs when the relay
  returns. What still permanently closes a socket's subs is a failure
  on the first connection attempt (`reconnectAttempts === 0`) — e.g.
  the relay is down when a sub is first attached, including right
  after the 5s `ensureRelay` watchdog in `index.ts` resurrects a
  relay that nostr-tools dropped from the pool (a resurrected relay
  starts with zero subscriptions, so the socket alone is deaf).
  Recovery for that path is
  [`src/nostr/persistent_sub.ts`](src/nostr/persistent_sub.ts)'s
  job: one sub per (connection, relay), `onclose` marks it dead, a
  5s retry re-issues the REQ (`since` resumed from the death time,
  capped). Long-lived subs still MUST go through `openPersistentSub`,
  never raw `pool.subscribeMany`.
- **URL canonicalization.** `SimplePool` parses relay URLs via
  WHATWG URL (`wss://nos.lol` → `wss://nos.lol/`), and pool
  callbacks emit the canonical form. Use `normalizeRelayUrl` from
  [`src/nostr/outbox.ts`](src/nostr/outbox.ts) when comparing —
  raw `bootstrap.includes(url)` against unnormalized constants
  silently misses.
- **Wallet.dispose() is in the shutdown path** — it tears down the
  VtxoManager poll + ContractWatcher SSE + ArkProvider SSE so the
  Ark server sees a clean disconnect.

## When to read what

- *adding a NWC method* → [`src/nostr/service.ts`](src/nostr/service.ts)
  dispatch + [`src/lib/methods.ts`](src/lib/methods.ts) (advertise) +
  add handler under `src/handlers/`. NIP-47 spec: §10 of DESIGN.md.
- *schema change* → [`src/db.ts`](src/db.ts) (append migration).
  TransactionRow shape lives in [`src/lib/transaction.ts`](src/lib/transaction.ts).
- *swap lifecycle questions* → [`src/boltz.ts`](src/boltz.ts) for the
  listener / reconcile, [DESIGN.md §5](DESIGN.md) for the flow.
- *UI change* → [`src/web/views/`](src/web/views/); routes in
  [`src/web/server.ts`](src/web/server.ts).
- *relay status / outbox behavior* → [`src/nostr/outbox.ts`](src/nostr/outbox.ts)
  for discovery, dispatch in [`src/index.ts`](src/index.ts),
  fragment renderers in [`src/lib/relay_status.ts`](src/lib/relay_status.ts).
- *adding a live-pushed UI fragment* → [`src/lib/sse.ts`](src/lib/sse.ts)
  is the broadcast hub; emit named events from `index.ts`, swap
  innerHTML on a `data-*` slot from `layout.ts`'s SSE script.
- *adding an SWR-cached read* → [`src/lib/cache.ts`](src/lib/cache.ts)
  + wire `.seed()` / `.onUpdate()` in `index.ts`; the route reads
  `.snapshot()` and fires `.refresh()` without awaiting.
- *bridge-native send (operator sends own funds: Ark / LN / onchain
  offboard), consolidate-all refresh, fee/sweep & sub-dust semantics,
  rail-aware VTXO breakdown* → [SEND_DESIGN.md](SEND_DESIGN.md).
- *unified wallet history (/history): why a separate `history` table,
  mirrored vs self-owned kinds, keyset cursor, the boarding-deposit
  watcher + watermark, accepted gaps (PWA sends, plain ark receives)* →
  [HISTORY_DESIGN.md](HISTORY_DESIGN.md); code in `src/history.ts` +
  `src/boarding_history.ts`, view in `src/web/views/history.ts`.
- *bridge-native receive (dashboard handles: Ark address / CLINK noffer /
  onchain boarding), CLINK offers + NIP-57 zap plan, native onboarding vs
  Boltz chain swap, why a fixed boarding address is safe (relative CSV
  timelock), send↔receive ramp symmetry* → [RECEIVE_DESIGN.md](RECEIVE_DESIGN.md).
- *unilateral exit (ASP-free VTXO recovery): proof vault, degraded boot,
  Unroll.Session reuse via the stub indexer, per-vtxo execution, CPFP/sweep
  from the nsec P2TR, the /exit tab* → [EXIT_DESIGN.md](EXIT_DESIGN.md); the
  code is under `src/exit/` + `src/web/views/exit*`. Implementation planning,
  spike results, and the regtest drill are in [EXIT_PLAN.md](EXIT_PLAN.md).
- *why a decision was made* → [DESIGN.md](DESIGN.md) §2 / §6 / §9.
