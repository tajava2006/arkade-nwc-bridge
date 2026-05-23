# CLAUDE.md

You are working on **arkade-nwc-bridge**, a single-process Bun
service that exposes an Ark-Protocol-backed Lightning wallet over
[NIP-47 (Nostr Wallet Connect)](https://github.com/nostr-protocol/nips/blob/master/47.md).
Read [`DESIGN.md`](DESIGN.md) for the *why* (architecture decisions,
schema rationale, footguns); this file is just the orientation.

## Project shape

```
src/
  defaults.ts                — static config constants (network, ASP,
                               relays, bind, port, db path). No env vars
  config.ts                  — thin wrapper over defaults
  account.ts                 — accounts table CRUD (loadAccount /
                               createAccount / parseNsecInput / generate)
  db.ts                      — bun:sqlite + WAL + append-only MIGRATIONS
  wallet.ts                  — privateKey → SingleKey → Wallet (in-memory repos)
  boltz.ts                   — ArkadeSwaps + SqliteSwapRepository,
                               SwapManager auto-claim/refund + listener +
                               boot-time reconcile for incoming swaps
  boltz_repository.ts        — SqliteSwapRepository: rows keyed on swap.id,
                               full BoltzSwap stashed as JSON blob
  polyfills.ts               — EventSource shim for the SDK's SSE streams
  index.ts                   — two-phase boot (setup-mode if no account;
                               ready-mode otherwise); SIGINT/SIGTERM teardown
  nostr/
    connections.ts           — connections table CRUD + URI builder
    crypto.ts                — nip44_v2 / nip04 (request encryption tag
                               picks; default nip04 per NIP-47 legacy rule)
    service.ts               — SimplePool, one SubCloser per connection,
                               registerConnection/unregisterConnection for
                               live (un)subscription on web mutations
  handlers/
    get_info.ts              — capabilities; no notifications advertised
    get_balance.ts           — (available + recoverable) × 1000 msat
    make_invoice.ts          — reverse swap; amount_msat = on-Ark received
    pay_invoice.ts           — submarine swap one-shot; amount_msat = paid
    lookup_invoice.ts        — connection-scoped SELECT
    list_transactions.ts     — connection-scoped, from/until/limit/offset
  lib/
    errors.ts                — NwcError + NIP-47 error code union
    html.ts                  — auto-escaping tagged-template HTML + raw()
    methods.ts               — SUPPORTED_METHODS (info event + dispatch)
    msat.ts                  — sat ↔ msat with exact-multiple check
    transaction.ts           — TransactionRow + NIP-47 mapping
  web/
    server.ts                — Bun.serve routes; AppState (setup|ready);
                               loopback only
    qr.ts                    — `qr` package wrapper (SVG)
    views/                   — server-rendered pages incl. setup.ts
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
  [`src/nostr/service.ts`](src/nostr/service.ts), never raw
  `Promise.all(pool.publish(...))` — a single timing-out relay
  must not crash the bridge.
- **Web → Nostr direction only.** Web calls
  `NostrService.registerConnection` / `unregisterConnection` via
  its narrow interface. Don't reach into pool/handler internals
  from web code.
- **Connection isolation.** `lookup_invoice` / `list_transactions`
  MUST filter on `connection_id` — a client can only see its own
  activity. The `/history` page is a separate concern (ark-side
  wallet view), wired to `wallet.getTransactionHistory()`.

## Hot footguns

- **No env vars.** Static defaults live in [`src/defaults.ts`](src/defaults.ts);
  the nsec lives in the `accounts` sqlite table (created via `/setup`).
  Don't reintroduce `.env` parsing — it was deliberately removed so the
  bridge is "clone + `bun run dev`" with no setup ritual.
- **Two-phase boot.** [`src/index.ts`](src/index.ts) starts the web
  server first, then either calls `bootReady` immediately (account
  exists) or waits for POST `/setup` to call it. Don't reorder this
  to "wallet first" — there's no nsec to hand the wallet until setup
  completes. AppState lives in [`src/web/server.ts`](src/web/server.ts).
- **Reference dirs** (`nips/`, `nostr-tools/`, `ts-sdk/`, `wallet/`,
  `arkd/`) are gitignored convenience clones. Don't link to them
  from anything that gets committed — public links will 404.
  External URLs are in [DESIGN.md §10](DESIGN.md).
- **Boltz endpoint is *not* `api.ark.boltz.exchange`.** The d.ts
  docstring lies; the real SDK default is `api.boltz.exchange` and
  that's what the production wallet uses. Don't pass `swapProvider`
  explicitly unless someone has a specific reason.
- **`createLightningInvoice` result.amount = post-fee on-Ark
  amount** (what lands in the wallet), not the invoice nominal.
  Our `transactions.amount_msat` mirrors this on both sides
  (incoming and outgoing report wallet movement, fees are
  separate). NIP-47's `amount` spec is ambiguous — we picked
  wallet-movement because it matches what arkade.money shows.
- **`recoverable` balance is sub-dust VTXOs, not "broken funds".**
  Include it in `get_balance` responses.
- **One subscription per connection.** A single multi-pubkey
  filter would create a race window on revoke; per-connection
  SubCloser map makes revoke O(1) Map.delete with no race.
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
- *why a decision was made* → [DESIGN.md](DESIGN.md) §2 / §6 / §9.
