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
  - Mint a fresh `nsec` and fund it.

### Install + configure

```bash
bun install
cp .env.example .env
$EDITOR .env        # set ARK_NSEC at minimum
```

`.env` essentials:

```dotenv
ARK_NSEC="nsec1..."                           # your Ark wallet backup
NWC_RELAYS="wss://relay.getalby.com/v1,wss://relay.damus.io"
```

Optional knobs (sane defaults provided): `ARK_SERVER_URL`, `NETWORK`,
`HTTP_BIND`, `HTTP_PORT`, `DB_PATH`. Don't change `HTTP_BIND` away
from `127.0.0.1` — there is no auth.

### Run

```bash
bun run dev          # development (hot reload)
bun run start        # plain
```

On first boot it creates `./data/bridge.sqlite` and applies migrations.
The operator UI is at <http://127.0.0.1:4282>.

## Connecting a nostr client

1. Open <http://127.0.0.1:4282/connections/new>, give the connection
   a label, optionally set a per-connection budget in sats, submit.
2. Copy the `nostr+walletconnect://…` URI or scan the QR code into
   your nostr client.
3. The connection works immediately — the bridge publishes the info
   event and starts listening before the page even renders.

### Why per-connection?

Each connection gets its own service keypair (NIP-47 SHOULD), its
own subscription, its own budget. Revoking a connection from
`/connections` stops listening on that pubkey — the URI is dead.
Other connections are unaffected.

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
| `/` | Balance, Ark address, active-connection count, settled-transaction count. |
| `/connections` | Active and revoked connections; create / revoke from here. |
| `/connections/:id` | Per-connection NWC log (every `make_invoice` / `pay_invoice` made through that connection). |
| `/history` | Raw Ark wallet history — every onchain/offchain movement the wallet sees, regardless of NWC. |

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
- **Backup the nsec, not the sqlite file.** Your Ark identity is
  the `nsec` — the sqlite file is just bridge bookkeeping (NWC
  connections, swap log) and is rebuilt from on-chain/indexer state
  on each boot. Losing it loses your connection list, not your
  money.

## Security model

- The HTTP server binds to **loopback only**. There is no auth and
  no inbound traffic from anywhere else — opening it to the network
  is unsafe.
- The `nsec` is stored **plaintext in `.env`**. Protect that file
  with normal filesystem permissions. Key-isolation paths (OS
  keystore, encrypted keyfile, dedicated signer) are documented in
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
