# arkade-nwc-bridge

A self-hosted [NIP-47 Nostr Wallet Connect](https://github.com/nostr-protocol/nips/blob/master/47.md)
wallet service that gives a nostr client (Amethyst, Damus, Primal,
Alby, …) Lightning payments without needing to run a Lightning node.
Clients **send** over NWC (`pay_invoice`); **receiving** is over a
static [CLINK noffer](RECEIVE_DESIGN.md), not per-client NWC invoices.
The Lightning side is handled by the Ark server operator's own swap
services against an [Ark Protocol](https://arkadeos.com) wallet: an
[intent solver](https://github.com/arkade-os/intent-solver) for sends,
and `subdustd` (in this repo) for receives and sends below the dust limit.

> [!WARNING]
> **Proof-of-concept — not audited.** This wallet exists to demonstrate
> unilateral exit. It has **not** had a security audit, and the Ark
> protocol it is built on is itself **not battle-tested**. Do **not** put
> a meaningful amount of money in here — use it only for small, everyday
> spending amounts.

> **Status:** Personal mainnet alpha. Operates against alpha SDKs and
> live Arkade infrastructure.

## Who this is for

You want a self-hosted Lightning wallet attached to your nostr
client (self-custody with real but bounded caveats — see the FAQ),
you'd rather not run a Lightning node + manage inbound liquidity,
but you *can* keep a personal machine up 24/7. Main use case:
zapping.

## How it works

```
nostr client  ──┐
                │   (NIP-47 over nostr relays)
                ▼
       ╔══════════════════════╗      ┌────────────┐
       ║  arkade-nwc-bridge   ║◄────►│ solver +   │  ◄── Lightning
       ║  (this repo, your    ║      │ subdustd   │
       ║   machine, 24/7)     ║      └────────────┘
       ║                      ║      ┌────────────┐
       ║                      ║◄────►│ Ark server │
       ╚══════════════════════╝      └────────────┘
```

Funds live as VTXOs in your Ark wallet. A Lightning send locks sats in
a covenant the solver can claim only with the payment's preimage — so it
gets them only by paying the invoice, and a failed payment comes back to
you. A Lightning receive is the reverse, through subdustd's atomic swap
(a shared VTXO with pre-signed spends), for any amount down to 1 sat.
Sends arrive over NWC (`pay_invoice`); receives come through the CLINK
noffer or NWC `make_invoice`. The bridge runs the swap state machines for
you either way.

## Setup

### Prerequisites

- [Bun](https://bun.com/) ≥ 1.3
- An Ark wallet identity — either paste an existing `nsec1…` at
  `/setup`, or let the bridge generate a fresh one and fund the
  resulting Ark address.

### Install + run

```bash
bun install
bun run dev          # development (hot reload)
# or `bun run start` for plain run
```

On first boot the bridge creates `./data/bridge.sqlite`, applies
migrations, and waits for setup. Open
<http://127.0.0.1:4282/setup> in a browser: pick the **Ark server**
(pre-filled with the operator's — leave it to use that, or point at your
own mainnet one), then either paste your
existing `nsec1…` or click *Generate* to mint a fresh one. The nsec
is stored in the local sqlite file and never leaves the machine.

The server choice is **fresh-start only**: there is no multi-server
wallet, so it locks once the account exists. To move to a different
Ark server you drain the funds and start over from a fresh sqlite.

No `.env` file, no env vars to set. The Ark server is picked at
`/setup` (pre-filled with the operator's); Lightning is configured in
`data/config.json` (below) — without it the bridge runs Ark-only. Other static
defaults (network, bind address, port, db path, plus the bootstrap
relay list and the
pubkey whose [NIP-65 outbox](https://github.com/nostr-protocol/nips/blob/master/65.md)
supplies the relay list for new NWC connections) live in
[`src/defaults.ts`](src/defaults.ts) — edit there if you need
something other than mainnet defaults. Don't change `HTTP_BIND` away
from `127.0.0.1` — there is no auth. (The Docker setup below is the
one exception: it binds `0.0.0.0` inside the container, with the
docker port mapping enforcing loopback at the host.)

### Running in Docker

Use this if you want the bridge inside an existing self-hosted stack
(e.g. alongside a personal Ark server, intent solver and subdustd running
in the same compose network).

```bash
docker build -t arkade-nwc-bridge .
```

Add to your compose:

```yaml
services:
  bridge:
    build: ./arkade-nwc-bridge   # or `image: arkade-nwc-bridge`
    volumes:
      - ./bridge-data:/app/data
    ports:
      - "127.0.0.1:4282:4282"
    restart: unless-stopped
```

The `./bridge-data` volume persists sqlite + WAL across restarts.
The `127.0.0.1:4282:4282` mapping keeps the web UI on the host's
loopback only.

To point the in-container bridge at a different ASP (or rebind the
HTTP listener), drop a JSON file into the data volume **before first
boot**:

```jsonc
// ./bridge-data/config.json
{
  "arkServerUrl": "http://arkd:7070",
  "httpBind": "0.0.0.0"
}
```

Any field of `Config` (`network`, `arkServerUrl`, `esploraUrls`,
`httpBind`, `httpPort`, `dbPath`) can be overridden;
missing fields fall through to the static defaults in
[`src/defaults.ts`](src/defaults.ts). The file is read once at boot.
Outside of docker the file simply isn't there and the bridge stays
zero-config.

### Pointing at a different Ark server (advanced)

The default points at the author's Ark server — that's the whole reason
`bun install && bun run dev` just works with no sample env to copy and
edit. The same `config.json` override retargets it, but a few things are
worth knowing first:

- **Lightning comes with the Ark server, not on its own.** The swap
  services keep their Ark-side liquidity on one Ark server, so they can
  only swap for that server. Lightning is the `lightning` block in
  `config.json` — `solverUrl` + `solverCard` (or `solverCardPath`, the
  solver's signed card), `subdustdUrl`, and `emulatorPubkey` (the
  operator's covenant cosigner — never the SDK default, which belongs to
  Ark Labs). All four come from the operator of that Ark server; the block
  is parsed strictly and a malformed one refuses boot. Without it the
  bridge runs Ark-only.
- **Only on a fresh start.** VTXOs exist on one Ark server and mean
  nothing on another, and the unilateral-exit proof vault mirrors the
  tree of the server it synced from — stale proofs don't merely go
  useless, they describe an exit that isn't there. Drain the wallet
  first (cooperative offboard, or exit), then wipe `data/`. There is no
  in-place migration, and the bridge won't stop you from trying.
- **Ark-only still covers what matters most.** Ark sends, on-chain
  deposits and withdrawals, and unilateral exit work against any Ark
  server — exit in particular is pure SDK + Esplora, which is the part
  most worth having on your own terms.

## Connecting a nostr client

1. Open <http://127.0.0.1:4282/connections/new>, give the connection
   a label, optionally set a per-connection budget in sats, submit.
2. Copy the `nostr+walletconnect://…` URI or scan the QR code into
   your nostr client.
3. The connection works immediately — the bridge publishes the info
   event and starts listening before the page even renders.

### Why per-connection?

Each connection gets its own service keypair (NIP-47 SHOULD), its
own subscription, its own budget, and its own relay set baked into
the URI at creation time. Revoking a connection from `/connections`
stops listening on that pubkey — the URI is dead. Other connections
are unaffected.

The relay set for each new URI comes from the operator's NIP-65
outbox (the pubkey hardcoded in [`src/defaults.ts`](src/defaults.ts));
existing connections keep their original relay set for life. If you
update your outbox list later, only *future* connections pick up
the new relays — existing clients keep working on whatever relays
they baked in. If a client's relays all die, revoke + reissue.

## What the bridge supports

NIP-47 methods implemented:

- `get_info`
- `get_balance`
- `make_invoice` (Lightning → Ark via subdustd's atomic receive, any amount)
- `pay_invoice` (Ark → Lightning via the solver; below dust via subdustd's atomic send)
- `lookup_invoice`
- `list_transactions`

`notifications` (kind 23197) is intentionally not advertised —
clients fall back to polling, which is fine for the zap use case.

### Receiving

`make_invoice` and the static [CLINK noffer](RECEIVE_DESIGN.md) share one
LN-receive core (`src/ln_receive.ts`) — an atomic receive against subdustd
for every amount, carrying a NIP-57 description hash when the payer zaps —
so a connected NWC client and a noffer payer get identical behavior, a
1-sat zap included.

The noffer stays the public handle: shown on the dashboard alongside the
Ark address (offchain L2) and the onchain boarding address, a payer scans
it, names an amount, and the invoice settles onto Ark. `make_invoice`
covers clients that want per-invoice receive over their own private
connection.

### Sub-dust amounts

Lightning works **both directions** below the 330-sat dust limit
(zap-sized sends and receives), and it is **atomic** — you don't trust
the swap provider to hold up its end.

A sub-dust amount can't be its own VTXO: it would be below the on-chain
dust threshold, so it can't be spent into a mempool, which means no
vHTLC to hang an ordinary swap on. Instead both sides share a single
regular (≥ dust) VTXO carrying four spend leaves, and pre-sign the claim
pair up front. The payment is a *split* of that shared output rather
than a transfer of the whole thing — the claimer takes its amount, the
funder's remainder comes back as one regular VTXO. Either the preimage
is revealed and both legs settle, or the refund timelock passes and the
funder recovers everything; there is no state where one side is paid and
the other isn't. Sends carry a 0.5% fee, folded into the claim output.

Full mechanics, including the failure analysis, in
[`ATOMIC_SUBDUST_PLAN.md`](ATOMIC_SUBDUST_PLAN.md) (§10 is current).
[`SEND_DESIGN.md`](SEND_DESIGN.md) and
[`RECEIVE_DESIGN.md`](RECEIVE_DESIGN.md) describe the dust+ swap rails.

### Unilateral exit (works with the Ark server dead)

The bridge continuously mirrors every VTXO's pre-signed exit proofs
into its own sqlite (the *vault*). If the Ark server disappears — or
turns hostile — the bridge still boots (**degraded mode**) and the
`/exit` tab walks each VTXO back to the Bitcoin base layer: broadcast
the pre-signed chain as zero-fee 1P1C packages CPFP-paid from an
onchain fuel address (same nsec, no extra backup), wait out the CSV
timelock, sweep to a plain address you alone control. A stuck package
(mempool spike mid-exit) gets a one-button **fee boost** — the CPFP
child is replaced via RBF at the next-block rate. This is what makes
the wallet genuinely self-custodial: with Ark, seed alone ≠ recovery —
you also need the proofs, and the vault keeps them.
Design in [`EXIT_DESIGN.md`](EXIT_DESIGN.md); a fully automated
regtest drill (`regtest-e2e/`) proves the whole path end-to-end.

The web UI surfaces these views:

| Page | What's there |
|---|---|
| `/setup` | First-run identity flow (paste or generate nsec). Shown automatically until an account exists; redirects to `/` once configured. |
| `/` | Balance, exit readiness (proven vs ASP-claimed VTXOs), the three receive handles (Ark address, CLINK noffer with live relay status, onchain boarding address), active-connection count. Balance refreshes in place over SSE — first visit may briefly show the last cached value before the live one lands. In degraded mode this becomes a red status page with vault readiness + the exit-fuel address. |
| `/send` | Bridge-native send of the operator's own funds — Ark / Lightning / onchain (cooperative offboard), rail auto-detected from the pasted destination, plus a consolidate-all refresh. |
| `/exit` | One row per vaulted VTXO: expiry countdown, measured exit cost at the current fee rate, economic verdict. Per-VTXO detail page draws the pre-signed chain as a DAG with live onchain status, runs the exit, shows the CSV countdown, sweeps — and offers the fee boost when a step sits underpriced in the mempool. Works identically in degraded mode. |
| `/connections` | Active and revoked connections; create / revoke from here. Top panel shows the bootstrap relays and the current outbox set (what new connections will use); each connection row has a live `N/M ●` relay badge that updates in place as relays come and go. |
| `/connections/:id` | Per-connection NWC log (every `pay_invoice` made through that connection) plus a per-relay status table for that connection's baked-in relay set. |

The pages are still server-rendered HTML; the live updates come
through a single SSE stream at `/events` that swaps `innerHTML` on
small marker slots. No client framework, no build step.

## Operational notes

- **24/7 uptime expected.** The bridge auto-renews your VTXOs as they
  near expiry. If it stays offline too long the Ark server sweeps them
  — but there's nothing to recover by hand: the next settlement round
  (run automatically once it's back up) folds them into fresh VTXOs.
  The cost isn't manual work, it's trust — while swept you've given up
  the unilateral-exit guarantee on those funds until the refresh
  restores it. If you can't keep it up, this isn't the right tool.
- **`recoverable` balance counts but isn't spendable as-is.** These are
  swept VTXOs — they've lost their unilateral-exit backing (a batch
  expired, or the amount is too small to exit on its own). The displayed
  balance includes them, but the wallet keeps them out of ordinary
  offchain sends: spending one would taint the exit path of whatever it
  mixes with. A refresh re-mints them into clean, spendable VTXOs —
  automatically over time, or at once via a consolidate-all refresh or a
  cooperative (onchain) offboard.
- **Lightning sends carry a fee** — the solver's quote (a percentage plus
  a routing estimate), or a small share below dust; receives carry none.
  You'll see it as `fees_paid` in the per-connection history, and on the
  Send tab before you confirm.
- **Backup the nsec separately.** Your Ark identity is the `nsec`
  stored in `accounts`. NWC connections, swap log, and other
  bookkeeping in the same sqlite file rebuild from on-chain/indexer
  state on each boot, but the nsec doesn't — if you lose the
  sqlite file you lose access to the funds at its Ark address.
  The web UI shows the nsec only once, on the setup screen; after
  that recover it with `bun run show-nsec` (reads the hex secret
  from the sqlite file — the live one, or pass another sqlite path,
  e.g. a backup copy or a docker volume dir, as an argument — and
  prints it as `nsec1…`/`npub1…`). Since
  the key is also a full nostr identity, a phone nostr signer —
  [Amber](https://github.com/greenart7c3/Amber) (Android) or Clave
  (iOS) — makes a good backup home and lets you use the same
  identity across nostr apps later.

## Security model

- The HTTP server binds to **loopback only**. There is no auth and
  no inbound traffic from anywhere else — opening it to the network
  is unsafe.
- The `nsec` is stored **plaintext in the sqlite file**
  (`./data/bridge.sqlite`, table `accounts`). Protect that file with
  normal filesystem permissions. Key-isolation paths (OS keystore,
  encrypted keyfile, dedicated signer) are documented in
  [`DESIGN.md`](DESIGN.md) §6 but not implemented — they need
  signing-API support the current Ark SDK doesn't offer through a
  remote interface.
- Per-connection budgets cap exposure if a single nostr client is
  compromised. Set them tight if it matters to you.

## Related projects

- [arkade-os/ts-sdk](https://github.com/arkade-os/ts-sdk) — the Ark
  protocol TypeScript SDK this bridge builds on.
- [arkade-os/intent-solver](https://github.com/arkade-os/intent-solver) —
  the solver the operator runs for Lightning sends.

## Contributing

This is a personal hack; PRs welcome but expect them to sit while
the author tests on mainnet with small amounts. See
[`DESIGN.md`](DESIGN.md) for why things are the way they are and
[`CLAUDE.md`](CLAUDE.md) for the file map and conventions.
