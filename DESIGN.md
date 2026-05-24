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

The Lightning side is handled via [Boltz](https://docs.boltz.exchange)
submarine/reverse swaps over [Ark Protocol](https://github.com/arkade-os/ts-sdk)
VTXOs. The Ark client wallet ([arkade-os/wallet](https://github.com/arkade-os/wallet))
uses the same plumbing, so this bridge is essentially "that wallet's
Lightning path, exposed over NWC".

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
| Boltz endpoint | **SDK default** (no explicit override) | `ArkadeSwaps.create` defaults to `api.boltz.exchange`, the same endpoint the arkade.money production wallet uses, with lower submarine fees (0.1% vs 0.25%) than `api.ark.boltz.exchange`. The d.ts docstring incorrectly claims the latter is the default — we verified the actual default in the compiled SDK. |

## 3. Architecture

```
┌──────────────────────────────────────────────────────┐
│  Operator Web UI  (Bun.serve, server-rendered HTML)  │
│  /, /connections (list/new/:id/revoke), /history     │
│  /events: SSE feed for outbox / connection / balance │
│          / history fragments (no client framework)   │
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
│  Wallet Layer   (@arkade-os/sdk + @arkade-os/boltz)  │
│  ArkadeSwaps with SwapManager auto-claim/refund      │
│  SqliteSwapRepository for resume-across-restarts     │
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
- ASP (`https://arkade.computer`)
- Boltz mainnet (`api.boltz.exchange`)
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

`nostr.service` → shared pool + DB + handlers + boltz SDK. Takes the
pool as a constructor parameter; doesn't construct its own.

`handlers` → DB + boltz SDK. Don't know about nostr/web.

`boltz` → DB (for the SwapRepository).

`index.ts` is the only place that owns the shared SimplePool. It
wires `pool.onRelayConnectionSuccess/Failure` once, then dispatches
into:
- `SseHub.broadcast('outbox-update', …)` — re-renders the outbox
  panel on the connections page
- `SseHub.broadcast('connection-update', …)` — re-renders the per-
  connection relay badge / detail table for each connection whose
  relays include the changed URL

It also runs a 5-second `ensureRelay` watchdog over the union of
bootstrap + current outbox + every active connection's relays, to
work around nostr-tools' habit of dropping relays from the pool
once `enableReconnect`'s backoff gives up (see §9).

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
connections (
  id                  INTEGER PRIMARY KEY,
  label               TEXT,
  service_secret_hex  TEXT    NOT NULL,
  service_pubkey_hex  TEXT    NOT NULL UNIQUE,
  client_pubkey_hex   TEXT    NOT NULL,
  relays_json         TEXT    NOT NULL DEFAULT '[]',
  budget_msat         INTEGER,                    -- null = unlimited
  spent_msat          INTEGER NOT NULL DEFAULT 0,
  expires_at          INTEGER,
  created_at          INTEGER NOT NULL,
  revoked_at          INTEGER
)

-- Unified NWC log: type='incoming' (make_invoice / reverse swap)
-- and type='outgoing' (pay_invoice / submarine swap) live together.
-- amount_msat is on-Ark wallet movement, NOT invoice nominal.
-- fees_paid_msat captures the gap.
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
  swap_id             TEXT,                       -- BoltzSwap.id
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

-- @arkade-os/boltz-swap's SwapRepository backing store. id/type/
-- status/created_at indexed; full BoltzSwap object is a JSON blob
-- in `data`. We never query swap internals from the bridge — the
-- SDK does — so normalizing per-variant fields would only couple us
-- to its data shape.
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
correction instead, or older databases diverge.

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
1. msat → sat; reject non-multiple-of-1000.
2. `swaps.createLightningInvoice({ amount, description })` →
   BOLT11 + payment_hash + expiry. `result.amount` is the post-fee
   on-Ark amount that will land in the wallet.
3. Write a pending `transactions` row with `amount_msat = receivedMsat`
   and `fees_paid_msat = invoice nominal − receivedMsat`.
4. Return the invoice immediately. Settlement is asynchronous:
   - Boltz drops a VHTLC at our swap address once the LN side is paid.
   - `SwapManager`'s auto-claim loop claims it into the Ark wallet.
   - `onSwapCompleted` listener flips the row to `settled`.

### `pay_invoice` (Ark → LN)
1. `decodeInvoice` for amount/payment_hash. Reject 0-amount invoices
   (we don't yet honor NIP-47's `params.amount`).
2. Budget check against `connection.budget_msat`.
3. Insert pending `transactions` row with `amount_msat = invoiceMsat`
   as a placeholder.
4. `swaps.sendLightningPayment({ invoice })` — one-shot: creates
   the submarine swap, sends the VTXO, awaits LN settlement, returns
   preimage. Auto-refunds on failure via `SwapManager`.
5. On success: `UPDATE` `amount_msat = paidMsat` (the on-Ark amount
   that actually left the wallet, including the swap fee) and
   `fees_paid_msat = paidMsat − invoiceMsat`. Bump
   `connections.spent_msat`. Return preimage.

### `lookup_invoice` / `list_transactions`
Read-only against `transactions`. **Scoped to the calling connection**
via `connection_id` — a client never sees activity belonging to
other connections on the same wallet. `lookup_invoice` uses the same
table for both `type` values; the response `type` field
disambiguates.

### Amount semantics — the consistent story

`transactions.amount_msat` = **on-Ark wallet movement**:
- outgoing: what left the wallet (invoice + swap fee)
- incoming: what landed in the wallet (invoice − swap fee)

`fees_paid_msat` = the gap (always positive). NIP-47's spec is
ambiguous on whether `amount` means "invoice nominal" or "what
actually moved", but matching wallet movement is what makes the
number useful to a user reasoning about their balance — and it's
what arkade.money's wallet UI does.

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

- `NETWORK` / `ARK_SERVER_URL` / `HTTP_BIND` / `HTTP_PORT` /
  `DB_PATH` — boring single values.
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

The identity (`nsec`) is *not* a constant — it's captured at
runtime through the `/setup` flow and persisted in the `accounts`
sqlite table; see §2 *Identity input*.

The Boltz endpoint is intentionally not configurable — SDK default
is the right answer (§2).

### Two-phase boot

`src/index.ts` always loads defaults and opens the DB first, then
inspects the `accounts` table:

- **No row** → start the web server in *setup mode*. Every route
  except `/setup` redirects there. POST `/setup` parses or generates
  an nsec, INSERTs the account row, and calls `bootReady` in-process
  to bring up wallet → boltz → nostr. On `bootReady` failure the
  just-inserted row is deleted so the user can retry cleanly (the
  /setup response includes the generated nsec on failure so a
  generate-mode crash doesn't silently lose the key).
- **Row exists** → call `bootReady` synchronously, then start the
  web server in *ready mode*.

The mutable handle lives in `AppStateRef` ([`src/web/server.ts`](src/web/server.ts)).
Shutdown checks `state.current.mode` so SIGINT during setup mode
skips wallet/boltz/nostr disposal (nothing to dispose yet).

## 9. Known footguns / known issues

- **VTXO expiry under downtime**: `wallet.create` enables a 3-day
  renewal threshold by default, so the bridge auto-renews as long
  as it's running. Extended downtime → swept VTXOs → recoverable via
  `wallet.getVtxoManager().recoverVtxos()` (not currently surfaced
  through the UI). 24/7 uptime is the design assumption.
- **Mainnet, alpha SDKs**: `@arkade-os/sdk` and Boltz Ark plumbing
  are still alpha. Operate with small amounts.
- **`processed_events` retention**: grows monotonically. At zap-
  level volume this is fine for years; eventually a retention
  policy would matter.
- **`db.exec` deprecation hint**: Bun's typings flag the current
  `db.exec(sql)` signature as deprecated. No runtime issue, just
  a hint to clean up when the replacement API stabilizes.
- **Wallet-handler crash recovery for `pay_invoice`**: If the
  process dies *after* `sendLightningPayment` settled on Boltz but
  *before* our row UPDATE, the row stays `pending` and there's no
  reconcile path for the outgoing side (only incoming). Recovery
  would need to fetch the swap by payment_hash on boot — not
  implemented because handler crashes mid-await are vanishingly
  rare for a single-user bridge.
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
- **nostr-tools `enableReconnect` gives up**: after a transient
  disconnect, nostr-tools retries with backoff (10s, 10s, 10s,
  20s, 20s, 30s, 60s) — but if a retry attempt *also* fails
  (relay still down), it sets `skipReconnection=true` and
  removes the relay from `pool.relays` entirely, after which
  `listConnectionStatus` no longer reports the URL at all. The
  5-second `ensureRelay` watchdog in [`src/index.ts`](src/index.ts)
  exists to resurrect these — it iterates the bridge's
  bootstrap ∪ current outbox ∪ active-connection relays union and
  calls `pool.ensureRelay(url)` on each. ensureRelay is a free
  no-op for connected relays; for removed ones it re-adds and
  retries. Without that loop, a relay that drops for longer than
  the internal backoff stays "offline" in the UI forever.
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
