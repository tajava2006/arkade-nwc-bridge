# arkade-nwc-bridge

A self-hosted [NIP-47 Nostr Wallet Connect](https://github.com/nostr-protocol/nips/blob/master/47.md)
wallet service that gives a nostr client (Amethyst, Damus, Primal,
Alby, …) Lightning send/receive without needing to run a Lightning
node. The Lightning side is handled via [Boltz](https://docs.boltz.exchange)
submarine/reverse swaps against an [Ark Protocol](https://arkadeos.com)
wallet.

> **Status:** Personal mainnet alpha. Operates against alpha SDKs and
> live Boltz/Arkade infrastructure. Use small amounts.

## Who this is for

You want a self-custodial Lightning wallet attached to your nostr
client, you'd rather not run a Lightning node + manage inbound
liquidity, but you *can* keep a personal machine up 24/7. Main use
case: zapping.

## How it works

```
nostr client  ──┐
                │   (NIP-47 over nostr relays)
                ▼
       ╔══════════════════════╗      ┌────────────┐
       ║  arkade-nwc-bridge   ║◄────►│   Boltz    │  ◄── Lightning
       ║  (this repo, your    ║      └────────────┘
       ║   machine, 24/7)     ║
       ║                      ║      ┌────────────┐
       ║                      ║◄────►│ Ark server │
       ╚══════════════════════╝      │ (arkade.   │
                                     │  computer) │
                                     └────────────┘
```

Funds live as VTXOs in your Ark wallet. Every Lightning send hands
sats to Boltz over Ark in exchange for a Lightning payment; every
Lightning receive does the reverse. The bridge runs the swap state
machine for you and exposes the result over NWC.

## Setup

### Prerequisites

- [Bun](https://bun.com/) ≥ 1.3
- An Ark wallet identity. You can either:
  - Restore your [arkade.money](https://arkade.money/) wallet with
    delegation **disabled** in settings, and copy out the `nsec`
    backup, **or**
  - Let the bridge generate a fresh `nsec` and fund the resulting Ark
    address.

### Install + run

```bash
bun install
bun run dev          # development (hot reload)
# or `bun run start` for plain run
```

On first boot the bridge creates `./data/bridge.sqlite`, applies
migrations, and waits for an identity. Open
<http://127.0.0.1:4282/setup> in a browser and either paste your
existing `nsec1…` or click *Generate* to mint a fresh one. The nsec
is stored in the local sqlite file and never leaves the machine.

No `.env` file, no env vars to set. Static defaults (network, ASP,
bind address, port, db path, plus the bootstrap relay list and the
pubkey whose [NIP-65 outbox](https://github.com/nostr-protocol/nips/blob/master/65.md)
supplies the relay list for new NWC connections) live in
[`src/defaults.ts`](src/defaults.ts) — edit there if you need
something other than mainnet defaults. Don't change `HTTP_BIND` away
from `127.0.0.1` — there is no auth. (The Docker setup below is the
one exception: it binds `0.0.0.0` inside the container, with the
docker port mapping enforcing loopback at the host.)

### Running in Docker

Use this if you want the bridge inside an existing self-hosted stack
(e.g. alongside a personal Ark server / Boltz instance running in the
same compose network).

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

Any field of `Config` (`network`, `arkServerUrl`, `httpBind`,
`httpPort`, `dbPath`) can be overridden; missing fields fall through
to the static defaults in [`src/defaults.ts`](src/defaults.ts). The
file is read once at boot. Outside of docker the file simply isn't
there and the bridge stays zero-config.

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
- `make_invoice` (Lightning → Ark via Boltz reverse swap)
- `pay_invoice` (Ark → Lightning via Boltz submarine swap)
- `lookup_invoice`
- `list_transactions`

`notifications` (kind 23197) is intentionally not advertised —
clients fall back to polling, which is fine for the zap use case.

The web UI surfaces these views:

| Page | What's there |
|---|---|
| `/setup` | First-run identity flow (paste or generate nsec). Shown automatically until an account exists; redirects to `/` once configured. |
| `/` | Balance, Ark address, active-connection count, settled-transaction count. Balance refreshes in place over SSE — first visit may briefly show the last cached value before the live one lands. |
| `/connections` | Active and revoked connections; create / revoke from here. Top panel shows the bootstrap relays and the current outbox set (what new connections will use); each connection row has a live `N/M ●` relay badge that updates in place as relays come and go. |
| `/connections/:id` | Per-connection NWC log (every `make_invoice` / `pay_invoice` made through that connection) plus a per-relay status table for that connection's baked-in relay set. |
| `/history` | Raw Ark wallet history — every onchain/offchain movement the wallet sees, regardless of NWC. Same stale-while-revalidate behavior as the dashboard. |

The pages are still server-rendered HTML; the live updates come
through a single SSE stream at `/events` that swaps `innerHTML` on
small marker slots. No client framework, no build step.

## Operational notes

- **24/7 uptime expected.** The bridge auto-renews your VTXOs before
  they expire (3-day threshold by default). Extended downtime means
  VTXOs get swept by the Ark server — recoverable, but a hassle. If
  you can't keep it up, this isn't the right tool.
- **`recoverable` balance is normal.** Small change outputs that
  aren't worth a unilateral exit on their own. They're still
  spendable offchain; the balance you see already includes them.
- **Boltz takes a fee** on every Lightning send (currently ~0.1%
  submarine, ~0.25% reverse). You'll see the gap as `fees_paid` in
  the per-connection history.
- **Backup the nsec separately.** Your Ark identity is the `nsec`
  stored in `accounts`. NWC connections, swap log, and other
  bookkeeping in the same sqlite file rebuild from on-chain/indexer
  state on each boot, but the nsec doesn't — if you lose the
  sqlite file you lose access to the funds at its Ark address.
  Export the nsec to a password manager.

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

- [arkade-os/wallet](https://github.com/arkade-os/wallet) — the
  reference Ark Wallet web app. Same Lightning plumbing under the
  hood. Useful for managing the same identity outside NWC.
- [arkade-os/ts-sdk](https://github.com/arkade-os/ts-sdk) — the Ark
  protocol TypeScript SDK this bridge builds on.
- [Boltz Ark docs](https://docs.boltz.exchange) — the swap provider.

## Contributing

This is a personal hack; PRs welcome but expect them to sit while
the author tests on mainnet with small amounts. See
[`DESIGN.md`](DESIGN.md) for why things are the way they are and
[`CLAUDE.md`](CLAUDE.md) for the file map and conventions.

## License

MIT.
