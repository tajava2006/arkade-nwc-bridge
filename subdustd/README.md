# subdustd

The server side of atomic sub-dust Lightning swaps (amounts below the 330-sat
dust limit), split out of the Boltz fork's `SubdustAtomicRouter` into its own
service. The protocol (`ATOMIC_SUBDUST_PLAN.md`) is unchanged: 4-leaf shared
vtxo, presigned claim/cancel pairs, split delta. It imports the same
`src/atomic` library the bridge uses, so the client and server cannot drift.

It serves the same REST contract the bridge already speaks
(`/v2/subdust/atomic/{send,receive}/…`), so the bridge only changes its base URL.

## Run

```bash
bun run subdustd <config.json>       # = bun run subdustd/main.ts <config.json>
```

Docker: build with the bridge repo root as context
(`docker build -f subdustd/Dockerfile .`), mount the config at
`/config/subdustd.json`. The image's HEALTHCHECK probes `/healthz` on the port
in that same file.

`/healthz` is liveness only. An unreachable LND or arkd refuses new swaps on
the paths that need them; it does not restart the process, which still has
old swaps to settle and refund.

## Config

One JSON file, no env vars. Unknown keys are rejected, so a misspelled knob
fails boot instead of silently falling back to its default. Boot also refuses
when the LND cert, macaroon or key file is unreadable.

```json
{
  "network": "bitcoin",
  "arkdUrl": "http://arkd:7070",
  "lnd": {
    "socket": "172.28.0.1:10009",
    "certPath": "/lnd/tls.cert",
    "macaroonPath": "/secrets/subdustd.macaroon"
  },
  "keyPath": "/data/subdustd.key",
  "dbPath": "/data/subdustd.sqlite",
  "http": { "host": "0.0.0.0", "port": 9010 },
  "logLevel": "info",
  "subdust": {
    "sendWindowSecs": 324000,
    "receiveWindowSecs": 21600,
    "payMarginSecs": 600,
    "blockTimeSecs": 600,
    "sendFeePercent": 0.5
  }
}
```

Required: `network`, `arkdUrl`, `lnd.*`, `keyPath`, `dbPath`. `http` defaults to
`127.0.0.1:9010` (set `0.0.0.0` in a container), `logLevel` to `info`, and every
`subdust` knob to the value below.

### Knobs carried over from the Boltz fork

The defaults are the tuned mainnet values from the old `boltz.conf` `[ark]`
block, not the fork's code defaults (its 1800s send window left every
multi-hop route NO_ROUTE).

| boltz.conf `[ark]` | subdustd | default | meaning |
|---|---|---|---|
| `subdustSendWindow` | `subdust.sendWindowSecs` | 324000 (90h) | ceiling of the send refund locktime T. T is sized per invoice from a `queryRoutes` measurement, and falls back to this value when the measurement fails. Also bounds the LN pay budget: `cltvLimit = (T − payMargin) / blockTime` |
| `subdustReceiveWindow` | `subdust.receiveWindowSecs` | 21600 (6h) | receive refund locktime T and hold-invoice expiry. Final CLTV = `⌈window / blockTime⌉ + 18` |
| `subdustPayMargin` | `subdust.payMarginSecs` | 600 | send: no new LN pay starts within this many seconds of T. Receive: a funding input must outlive T by this much |
| `subdustBlockTime` | `subdust.blockTimeSecs` | 600 | seconds per block for the cltv ⇄ time conversion |
| `subdustSendFeePercent` | `subdust.sendFeePercent` | 0.5 | send fee, `feeSats = ⌈a × pct / 100⌉`, taken in the claim split |
| `subdustRestUrl` | `arkdUrl` | — (required) | arkd REST endpoint |
| `subdustSignerKey` | `keyPath` | — (required) | the key now lives in its own file; it is no longer the fulmine wallet key |
| `subdustSelfExitDelay` | *(removed)* | — | only existed because the key was shared with fulmine, whose client lib hardcodes a 605184 exit delay. A dedicated key follows arkd's advertised delay |

Boot-time checks:

- **Refused:** `payMarginSecs >= sendWindowSecs` (no LN budget left, every send would fail), non-integer or non-positive windows, `sendFeePercent` outside `[0, 100)`.
- **Warned (mainnet only):** a send cltv budget under 288 blocks (long routes become NO_ROUTE), `sendFeePercent` 0 (we would front routing fees for free).

`payMarginSecs >= receiveWindowSecs` is allowed: receive uses the margin only as
funding headroom (the regtest drills run 60/60).
