# DESIGN.md

The *why* behind this bridge — design decisions, the layout that
follows from them, and the footguns we already stepped on. Code is
the source of truth for *how*; this file is for everything you
couldn't reconstruct from reading source.

For a quick orientation (file tree, dev commands, conventions),
see [`CLAUDE.md`](CLAUDE.md). For end-user setup, see
[`README.md`](README.md).

## 1. What this is

A NIP-47 [Nostr Wallet Connect (NWC)](https://github.com/nostr-protocol/nips/blob/master/47.md)
**wallet service** that bridges nostr clients to a self-custodial
Lightning experience without running a Lightning node.

The Lightning side is handled by the Ark server operator's own swap
services over [Ark Protocol](https://github.com/arkade-os/ts-sdk) VTXOs:
sends of dust and up through an [intent solver](https://github.com/arkade-os/intent-solver)
via the `@arkade-os/swap` client, and every receive plus sends below dust
through `subdustd` (`subdustd/`, the atomic shared-vtxo protocol in
[ATOMIC_SUBDUST_PLAN.md](ATOMIC_SUBDUST_PLAN.md)). Until 2026-11 this was
Boltz submarine/reverse swaps; the migration record is the operator
workspace's `SOLVER_MIGRATION_PLAN.md`.

Target user: someone who can keep a personal server (or laptop) up
24/7 but doesn't want to run a Lightning node + manage inbound
liquidity. Main use case: zapping from a nostr client like Amethyst.

## 2. Core design decisions

| Decision | Value | Why |
|---|---|---|
| Network | **mainnet** | NWC clients are mainnet-oriented; signet/mutinynet wouldn't actually integrate with anything. Operate with small amounts. |
| Runtime | **Bun** (TypeScript) | sqlite via `bun:sqlite`, native HTTP server, no build pipeline. |
| Frontend | **Server-rendered HTML** (no JS, no framework) | Few pages, local-only, build complexity not worth it. Tagged-template builder in [`src/lib/html.ts`](src/lib/html.ts) with auto-escape + `raw()` escape hatch. |
| Persistence | **SQLite** via `bun:sqlite` | Single file, WAL, foreign keys on. |
| Identity input | **`accounts` sqlite row**, captured via the first-run `/setup` web flow (paste or generate) | The Arkade wallet derives a single key from its mnemonic (path `m/44/1237/0'/0/0` — 1237 is Nostr's BIP-44 coin type) and exposes it as `nsec`. A single nsec is functionally equivalent to the mnemonic for this wallet, and matches the reference wallet's backup format so users can paste theirs in directly. Sqlite over `.env` so cloning the repo and running `bun run dev` is the entire setup; no file editing, no env vars. Plaintext-at-rest matches `.env` — same threat model (local-only, loopback-only, OS file perms). |
| Service keypair | **One per connection** | NIP-47 SHOULD; per-connection pubkey prevents linking payment activity across clients. |
| Notifications (kind 23197) | **Not implemented, not advertised** | The primary use case (zap sending) is satisfied by the synchronous 23195 response. Receive notifications need server→client push which requires a listener side we don't write; clients fall back to polling `lookup_invoice`. |
| Remote signer (NIP-46/Amber) delegation | **Rejected as infeasible** | See §6. |
| VTXO renewal delegation (Fulmine) | **Not enabled** | Adding a `delegatorProvider` injects a delegation path into the offchain tapscript, which changes the Ark address even for the same key. The arkade.money wallet defaults to delegate=ON, so importing the same nsec there produced a different address — explicitly noted because we burned swap fees rediscovering this. We assume 24/7 uptime instead. |
| HTTP exposure | **`127.0.0.1` bind, no auth** | All real outbound work goes through nostr relays (out-only). There's no inbound need; reverse proxy + auth would just complicate the threat model. |
| Lightning infrastructure | **The operator's own solver + subdustd + emulator, from `data/config.json`** | The swap client's defaults reach Ark Labs — its discovery registry, and the emulator key a send's instant-refund covenant leaf depends on. Overridden: our solver's card is the only discovery snapshot, and `emulatorPubkey` is ours, so no refund path hangs on a third party. Receives go through subdustd for every amount because the solver's hold invoice cannot carry a NIP-57 description hash (D10). |

## 3. Architecture

```
┌──────────────────────────────────────────────────────┐
│  Operator Web UI  (Bun.serve, server-rendered HTML)  │
│  /, /send, /exit(/:txid/:vout),                      │
│  /connections (list/new/:id/revoke)                  │
│  /events: SSE feed for outbox / connection / balance │
│  / exit-op / offboards / mode-change fragments       │
│  (no client framework)                               │
├──────────────────────────────────────────────────────┤
│  Outbox Watcher  (NIP-65 kind 10002)                 │
│  Bootstrap relays → discovery pubkey's relay list →  │
│  default for new-connection URIs                     │
├──────────────────────────────────────────────────────┤
│  Nostr Service  (per-connection subs on conn.relays) │
│  kinds 13194 / 23194 / 23195 over the shared pool    │
├──────────────────────────────────────────────────────┤
│  Handlers                                            │
│  get_info / get_balance / make_invoice / pay_invoice │
│  lookup_invoice / list_transactions                  │
├──────────────────────────────────────────────────────┤
│  Wallet Layer   (@arkade-os/sdk + @arkade-os/swap)   │
│  swap client (solver sends, drive auto-refund) +     │
│  atomic client (subdustd: receives, sub-dust sends)  │
├──────────────────────────────────────────────────────┤
│  Storage Layer  (bun:sqlite + WAL)                   │
└──────────────────────────────────────────────────────┘

           shared SimplePool ◄── owned by src/index.ts
                  │
                  └─ subscribed by: outbox watcher (kind 10002 on
                     bootstrap relays) + nostr service (per-conn
                     filters). Pool callbacks fire in index.ts and
                     fan out through SseHub to the browser.
```

All outbound:
- ASP (the operator's arkd)
- The operator's intent solver and subdustd (private network)
- Nostr relays (`wss://…`)

No inbound except local HTTP on loopback.

### Dependency direction

`web` → `nostr.NostrService` (narrow interface) + DB + `OutboxWatcher`
(read-only for the new-connection URI and the outbox-panel render).
`web` doesn't know about pool internals, handler internals, or
SimplePool. Mutating a connection (`createConnection` /
`revokeConnection`) calls `nostr.registerConnection` /
`unregisterConnection` so subscriptions and info events update live
without a bridge restart.

`nostr.outbox` → shared pool + DB (none). Subscribes on bootstrap
relays, emits an outbox-change callback on every distinct 10002.

`nostr.service` → shared pool + DB + handlers + Lightning rails. Takes
the pool as a constructor parameter; doesn't construct its own.

`handlers` → DB + `ln_send` / `ln_receive`. Don't know about nostr/web.

`solver_rail` / `swap_store` → DB (the swap client's own tables).

`index.ts` is the only place that owns the shared SimplePool. It
wires `pool.onRelayConnectionSuccess/Failure` once, then dispatches
into:
- `SseHub.broadcast('outbox-update', …)` — re-renders the outbox
  panel on the connections page
- `SseHub.broadcast('connection-update', …)` — re-renders the per-
  connection relay badge / detail table for each connection whose
  relays include the changed URL

It also runs a 5-second watchdog over the union of bootstrap +
current outbox + every active connection's relays, so relays we only
show status for (or only publish to) get a socket too. Every attempt
goes through the relay gate's backoff (see §9).

## 4. SQLite schema

Five user-facing tables + a schema_migrations bookkeeping table.
The bridge owns its own DB; it is *not* the Wallet's repository
(that one lives in-memory in this process and rebuilds from the
indexer on each boot).

```sql
-- The Ark identity. Schema permits multiple rows but the bridge
-- only ever loads the first (`ORDER BY id LIMIT 1`) — multi-account
-- would need history/connection scoping changes far beyond a
-- schema tweak. Stored as raw private-key hex; bech32 encoding/
-- decoding happens at the edges (UI, account.ts).
accounts (
  id          INTEGER PRIMARY KEY,
  nsec_hex    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
)

-- One row per NWC connection. Each gets a fresh service keypair;
-- the client secret from the URI is NOT stored (NIP-47 guidance).
-- `relays_json` is a JSON-encoded string[] of the outbox snapshot
-- at create time — the bridge subscribes to *these exact relays*
-- for the connection's whole lifetime, so an outbox list change
-- later doesn't silently break clients that baked the old set
-- into their URI.
-- Budget windows are computed, never stored: src/lib/budget.ts
-- derives the current window from (budget_renewal, now) — local
-- calendar-aligned — and sums `transactions` inside it, so there
-- is no reset job, no last-reset column, and nothing to catch up
-- on after downtime. 'never' is the one unbounded window; it reads
-- the O(1) spent_msat counter instead (fee-inclusive wallet
-- movement), which stays maintained for every renewal.
connections (
  id                  INTEGER PRIMARY KEY,
  label               TEXT,
  service_secret_hex  TEXT    NOT NULL,
  service_pubkey_hex  TEXT    NOT NULL UNIQUE,
  client_pubkey_hex   TEXT    NOT NULL,
  relays_json         TEXT    NOT NULL DEFAULT '[]',
  budget_msat         INTEGER,                    -- null = unlimited
  budget_renewal      TEXT    NOT NULL DEFAULT 'never',  -- daily|weekly|monthly|never
  spent_msat          INTEGER NOT NULL DEFAULT 0, -- lifetime, fee-inclusive
  expires_at          INTEGER,
  created_at          INTEGER NOT NULL,
  revoked_at          INTEGER
)

-- Unified NWC log: type='incoming' (make_invoice / reverse swap)
-- and type='outgoing' (pay_invoice / submarine swap) live together.
-- amount_msat is the BOLT11 nominal, both directions; fees_paid_msat
-- is our swap cost. Wallet movement is derived (see §5).
transactions (
  id                  INTEGER PRIMARY KEY,
  connection_id       INTEGER NOT NULL REFERENCES connections(id),
  type                TEXT    NOT NULL,    -- 'incoming' | 'outgoing'
  request_event_id    TEXT    NOT NULL UNIQUE,    -- replay protection
  invoice             TEXT    NOT NULL,
  payment_hash        TEXT    NOT NULL,
  amount_msat         INTEGER NOT NULL,
  fees_paid_msat      INTEGER,
  description         TEXT,
  swap_id             TEXT,                       -- solver swap id (rfq:…) or atomic swap id
  state               TEXT    NOT NULL,           -- pending|settled|failed|expired
  preimage            TEXT,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER,                    -- incoming only
  settled_at          INTEGER
)

-- Every nostr request event we've answered. PK = event_id is the
-- primary replay defense; see §7.
processed_events (
  event_id            TEXT    PRIMARY KEY,
  connection_id       INTEGER REFERENCES connections(id),
  method              TEXT,
  processed_at        INTEGER NOT NULL
)

-- Boltz era (until 2026-11): @arkade-os/boltz-swap's repository.
-- Kept because migrations are append-only; nothing reads it now. The
-- swap client's own tables (prefix swapclient_) are created by the
-- client itself, outside the migrations (src/swap_store.ts).
boltz_swaps (
  id          TEXT    PRIMARY KEY,
  type        TEXT    NOT NULL,    -- 'reverse' | 'submarine' | 'chain'
  status      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  data        TEXT    NOT NULL
)
```

Migrations are append-only ([`src/db.ts`](src/db.ts)). Once a version
is shipped its SQL must not change — bump the version and write a
correction instead, or older databases diverge. (One deliberate
exception on record: the 2026-07 schema-epoch reset collapsed the
first 16 migrations back into a single v1 while the solo-operator DB
was wiped on purpose; a pre-reset DB is refused at boot.)

## 5. NWC method flows

### `get_info`
Returns `methods` (the six we implement) + network. No
`notifications` advertised — see §2.

### `get_balance`
Returns `(available + recoverable) × 1000` msats. `recoverable` is
mostly sub-dust VTXOs that can't viably unilaterally exit on their
own, but they're freely spendable offchain (Ark merges them on
send), so reporting only `available` under-counts. The arkade.money
UI collapses these two buckets in its main balance number for the
same reason.

### `make_invoice` (LN → Ark)
`issueInvoice` (`src/ln_receive.ts`) serves both the CLINK noffer and
`make_invoice`, so the receive path exists exactly once and the NWC entry
point only adds its own bookkeeping.

1. msat → sat; reject non-multiple-of-1000. Optional `description_hash`
   (64-hex) passes through to the invoice — a client serving its own
   LNURL/zap flow commits its descriptionHash. A plaintext `description`
   becomes the memo when no hash is given (BOLT11 carries one or the other).
2. `issueInvoice` — every amount: generate the preimage, POST
   `/v2/subdust/atomic/receive/init` to subdustd with our payment hash; it
   mints a **hold** invoice (503 when its float cannot fund the amount — no
   unpayable invoice is ever issued). On payment subdustd funds a shared
   4-leaf vtxo and pre-signs the claim; we verify it and claim `a` out of
   that output, revealing the preimage subdustd needs to settle. Atomic in
   both directions — see [ATOMIC_SUBDUST_PLAN.md](ATOMIC_SUBDUST_PLAN.md).
   (The solver's hold invoice was the alternative above dust; it has no
   description hash, so zaps would lose their NIP-57 receipts — D10.)
3. Write a pending `transactions` row with `amount_msat` = the BOLT11
   nominal (exactly what the client asked for — the invoice is never
   inflated), `fees_paid_msat` = 0 (receives are 1:1), `swap_id` NULL —
   the reconciler matches the row by payment hash.
4. Return the invoice immediately. Settlement is asynchronous: no swap
   event exists, so `reconcileAtomicReceives` (30s, plus subdustd ws pokes)
   polls `/receive/status` and drives the swap: once funded and
   pre-signed, verify → claim → settle, then row `settled` (+preimage, ours
   all along); unsettled past the BOLT11 expiry (+15 min HTLC grace) →
   `expired`. Clients observe it through `lookup_invoice` /
   `list_transactions` polling (we advertise no notifications).

### `pay_invoice` (Ark → LN)
1. `decodeInvoice` for amount/payment_hash. Reject 0-amount invoices
   (we don't yet honor NIP-47's `params.amount`).
2. Budget check: `cycleSpentMsat` (current-window spend, pending rows
   included so in-flight payments reserve budget) + this invoice against
   `budget_msat`. No await between the check and the INSERT below, so
   concurrent requests can't jointly overshoot the cap.
3. Insert pending `transactions` row with `amount_msat = invoiceMsat`
   — the BOLT11 nominal, final from the start.
4. `sendLightning` (`src/ln_send.ts`, shared with the dashboard LN rail):
   - ≥ dust: the swap client pays through our solver — the wallet funds a
     covenant the solver can claim only with the payment's preimage
     (funded through our coin policy, `withSpendPolicy`). The client's
     drive refunds a failed payment by itself (at once through our
     emulator, or after the timelock). The preimage is the one the drive
     hash-verified on the solver's claim, re-checked here, or read off the
     claim witness via arkd — never the solver's word.
   - < dust: the atomic send against subdustd (fund a shared 4-leaf vtxo
     whole-input, hand it a pre-signed claim it can only take by paying).
5. On success: `fees_paid_msat = paidMsat − invoiceMsat`, `amount_msat`
   stays the nominal, and `connections.spent_msat` gains `paidMsat` in the
   same sqlite transaction (`settleOutgoing`, `src/ln_ledger.ts`). On an
   outcome that is not yet known (`needs_recovery`, or subdustd holding the
   presigs without answering) the row **stays pending** — the money may
   still move — and the client gets INTERNAL "do not retry". The swap
   listener (solver) or the atomic reconcile (sub-dust) settles it later;
   both run at boot too, so a payment interrupted by a restart is recorded.

### `lookup_invoice` / `list_transactions`
Read-only against `transactions`. **Scoped to the calling connection**
via `connection_id` — a client never sees activity belonging to
other connections on the same wallet. `lookup_invoice` uses the same
table for both `type` values; the response `type` field
disambiguates.

### Amount semantics — the consistent story

`transactions.amount_msat` = **the BOLT11 nominal**, both directions:
the number payer and payee agreed on. `fees_paid_msat` = what WE paid
to move it — the solver's fee (or the sub-dust share); always ours, never
the payer's. Wallet movement is derived, never stored:

- outgoing: debit = amount + fees (fee paid on top of the nominal)
- incoming: credit = amount − fees (fee taken out of the nominal)

The rule is symmetric — the fee always lands on us — even though it
reads "added" one way and "deducted" the other.

We used to store wallet movement in `amount_msat` instead (fee folded
into the outgoing amount). That double-shows the fee in any client
that renders amount and fee side by side, disagrees with the number a
payer can read out of the BOLT11 itself (`lookup_invoice` returns the
invoice — its `amount` should match what's encoded in it), and skews
zap history: NIP-57 receipt validation requires the bolt11 amount to
equal the zap request's, so a 21-sat zap must read 21, not 20 or 22.
Changed at the 2026-07 schema-epoch reset, together with the fee side
of receives: the invoice is never inflated above what the client asked
for — the payer pays the agreed number, and any receive cost comes out
of what lands on Ark (the receiver's cost of the LN → Ark move, exactly
like a merchant eating the card fee). Receives are 1:1 today.

## 6. Why NIP-46 delegation is rejected

The Ark `Identity` interface ([`ts-sdk/src/identity/index.ts`](https://github.com/arkade-os/ts-sdk/blob/main/src/identity/index.ts))
requires three signing surfaces:

1. `signMessage(msg, 'schnorr'|'ecdsa')` — arbitrary message
2. `sign(tx, inputIndexes?)` — PSBT inputs (BIP-341 Schnorr over sighash)
3. `signerSession()` — **MuSig2** interactive multi-round signing
   (nonce commitment, then partial signature)

NIP-46's only signing method is `sign_event`, which takes a Nostr
event template and signs `SHA256(canonical_json([0, pubkey,
created_at, kind, tags, content]))` — we can't coerce that hash to
match an arbitrary sighash. Even raw schnorr signing of an arbitrary
hash isn't in the spec. And MuSig2 is two interactive rounds with
shared state, not one sign-and-return.

So "park the nsec in Amber, run the bridge stateless from the
cloud" is structurally impossible until NIP-46 grows arbitrary
signing primitives. More realistic paths if key isolation becomes a
priority: OS keystore (macOS Keychain / libsecret), encrypted
keyfile with a boot-time passphrase, or a separate signer daemon
talking a custom protocol.

## 7. Replay protection

Defenses, in order of importance:

1. **`processed_events` PK on `event_id`** — primary defense.
   Nostr event ids are deterministic
   `SHA256(canonical_json([0, pubkey, created_at, kind, tags,
   content]))`, so replaying an event verbatim produces the same id,
   and `INSERT OR IGNORE` rejects it. Survives restarts (sqlite
   persistence).
2. **Signature binding to the id** — modifying any field changes
   the id, invalidating the signature; the attacker can't re-sign
   without the client secret.
3. **`since: now()` filter on subscription** — relays following the
   spec drop older events at delivery. Best-effort across relays.
4. **NIP-47 `expiration` tag** — if the client sets it, we drop
   anything past expiry. Most clients don't.
5. **LN payment_hash uniqueness backstop** — if the dedupe ever
   fails, paying the same invoice twice gets `already paid` from
   the receiver's LN node. Doesn't cover `make_invoice` though
   (that creates a new swap with no native idempotency), so the
   DB PK is the only thing keeping that side honest.

## 8. Configuration

There is no `.env` and no environment-variable surface. Static
defaults live as TypeScript constants in [`src/defaults.ts`](src/defaults.ts);
edit the source to deviate. They are:

- `NETWORK` / `HTTP_BIND` / `HTTP_PORT` / `DB_PATH` — boring single
  values.
- `ARK_SERVER_URL` — the *fallback* Ark server. The effective one is
  chosen once at `/setup` and then frozen (below); this serves as the
  setup pre-fill and the last-resort default.
- `OUTBOX_DISCOVERY_PUBKEY` — the operator's nostr pubkey, whose
  NIP-65 (kind 10002) outbox list is the source of truth for which
  relays new NWC connections will use.
- `OUTBOX_BOOTSTRAP_RELAYS` — small set of well-known indexer
  relays the outbox watcher subscribes on to fetch that 10002.
  Only purpose: discovery. Not used for NWC traffic.
- `NWC_RELAYS_FALLBACK` — the relay list a new connection gets if
  the outbox watcher couldn't resolve anything within
  `OUTBOX_INITIAL_TIMEOUT_MS` at boot. Keeps the bridge usable
  even with every bootstrap relay down.

The identity (`nsec`) and the Ark server are *not* constants — both are
captured at the first `/setup` and persisted (the `nsec` in `accounts`,
the server in the single-row `bridge_server` table, whose `boltz_url`
column is a Boltz-era leftover written empty). The server is then
**immutable**: there is no multi-server wallet, so changing it means
draining funds and starting from a fresh sqlite. See §2 *Identity input*.

Effective Ark server precedence: `data/config.json` > `bridge_server`
row > `defaults.ts`. A `data/config.json` that pins the URL (the docker /
regtest override) still wins over the fresh-start row; a disagreement is
logged. Lightning is `data/config.json`-only (`lightning`: solver URL +
card, subdustd URL, emulator key), parsed strictly; absent, the bridge
boots Ark-only and the LN methods refuse.

### Two-phase boot

`src/index.ts` always loads defaults and opens the DB first, then
inspects the `accounts` table:

- **No row** → start the web server in *setup mode*. Every route
  except `/setup` redirects there. POST `/setup` parses or generates
  an nsec, then **validates the chosen Ark server** (arkd `getInfo`
  network assert) *before* writing anything —
  the choice is immutable, so a typo'd or wrong-network URL would
  brick the install (or strand funds on an unreachable chain). On
  success it writes the `bridge_server` row and the account row
  together and calls `bootReady` in-process to bring up wallet →
  Lightning rails → nostr. On `bootReady` failure BOTH rows are deleted so the
  user can retry cleanly (the /setup response includes the generated
  nsec on failure so a generate-mode crash doesn't silently lose the
  key).
- **Row exists** → call `bootReady` synchronously (it resolves
  the Ark server from the `bridge_server` row, backfilling it from
  defaults for a pre-v4 DB), then start the web server in *ready
  mode*.

The mutable handle lives in `AppStateRef` ([`src/web/server.ts`](src/web/server.ts)).
Shutdown checks `state.current.mode` so SIGINT during setup mode
skips wallet/Lightning/nostr disposal (nothing to dispose yet).

## 9. Known footguns / known issues

- **VTXO expiry under downtime**: `wallet.create` enables a 3-day
  renewal threshold by default, so the bridge auto-renews as long
  as it's running. Extended downtime → swept VTXOs → recoverable via
  `wallet.getVtxoManager().recoverVtxos()` (not currently surfaced
  through the UI). 24/7 uptime is the design assumption.
- **Mainnet, alpha SDKs**: `@arkade-os/sdk` and `@arkade-os/swap` are
  still alpha. Operate with small amounts.
- **`processed_events` retention**: grows monotonically. At zap-
  level volume this is fine for years; eventually a retention
  policy would matter.
- **`db.exec` deprecation hint**: Bun's typings flag the current
  `db.exec(sql)` signature as deprecated. No runtime issue, just
  a hint to clean up when the replacement API stabilizes.
- **Crash recovery for `pay_invoice`** (fixed 2026-11): a payment whose
  handler never returned is settled at the next boot — the swap client
  replays every known swap to the ledger listener (matched by swap id, or
  by payment hash when the crash beat the link), and sub-dust sends are
  matched to their atomic swap row (`reconcileAtomicSendRows`). Before,
  only the sub-dust side had a reconcile.
- **`@bitcoinerlab/descriptors-core` boot error**: rarely on boot
  Bun throws `require() async module ... unsupported` for that
  dep; retrying boots cleanly. Looks like a transient ESM/CJS
  interop issue; haven't pinned down the trigger.
- **Outbox updates affect *new* connections only**: an existing
  connection's relay set is baked into its URI and persisted in
  `connections.relays_json` at creation time. The bridge keeps
  subscribing on that exact set for the rest of the connection's
  life. If the outbox watcher learns a new 10002 mid-process, the
  next connection picks up the new defaults; old connections do
  not — even on restart. If a customer's connection stops working
  because every relay it baked in died, the operator has to
  revoke + reissue. No auto-migration.
- **Relay reconnects: one path, behind a backoff gate.** Two things
  went wrong with the original design (found 2026-10, after nos.lol /
  nostr.mom / relay.damus.io blocked the operating IP). (1) Retries
  ran on fixed 5s timers — one per persistent sub plus the watchdog —
  with no memory: measured ~120 handshakes/minute against a relay that
  refuses the connection. (2) The pool ran with `enableReconnect`, and
  nostr-tools' internal reconnect loop raced ours: an `ensureRelay`
  that fails while the loop is mid-backoff makes the pool forget the
  relay object, which keeps reconnecting on its own while the next
  `ensureRelay` builds a second one — one leaked live socket per
  outage. Now the pool has no `enableReconnect`: a lost socket closes
  its subs and leaves the pool, `persistent_sub.ts` re-issues the REQ
  (capped `since` resume), and [`src/nostr/relay_gate.ts`](src/nostr/relay_gate.ts)
  — the pool's `allowConnectingToRelay` hook — decides whether an
  attempt may open a socket: 5s doubling to a 5-minute cap, ±20%
  jitter, and the count only resets after a connection has held 60s.
  Cost: after a long outage a relay can take up to ~5 minutes to come
  back, and requests older than `MAX_RESUME_LOOKBACK_SEC` are not
  replayed (already the rule).
- **Relay URL canonicalization**: `SimplePool` parses URLs through
  WHATWG URL (`wss://nos.lol` → `wss://nos.lol/`) and pool
  callbacks emit the canonical form. Constants in
  [`src/defaults.ts`](src/defaults.ts) are unnormalized for
  legibility; [`src/nostr/outbox.ts`](src/nostr/outbox.ts) exports
  `normalizeRelayUrl` to keep comparisons honest.

## 10. Reference repos

External — cloned locally for grep convenience but ignored by git,
so don't link to local paths from anything that gets pushed:

- **NIP-47 / NIP-46 / NIP-44 / NIP-04 / NIP-09**:
  https://github.com/nostr-protocol/nips
- **Ark TS SDK** (Wallet, Identity, providers):
  https://github.com/arkade-os/ts-sdk
- **Arkade Wallet** (reference NWC client + the source of the
  derivation path and delegation decision):
  https://github.com/arkade-os/wallet
- **arkd** (Ark service provider server, mostly informational):
  https://github.com/arkade-os/arkd
- **nostr-tools** (kinds/encryption/pool helpers):
  https://github.com/nbd-wtf/nostr-tools
