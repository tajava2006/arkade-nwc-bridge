# Unilateral-exit regtest drill (browser e2e)

The one path unit tests can't cover: real 1P1C package broadcasts, a real CSV
timelock, a real sweep — driven from the browser at localhost:4282 against a
full local regtest stack. This is the existence proof for the exit feature
(EXIT_PLAN.md #15, design in EXIT_DESIGN.md).

## What it needs

- Docker (colima or Docker Desktop) running.
- The `arkade-regtest` stack — by default the operator workspace's
  `../ts-sdk/regtest` submodule. Set `REGTEST_DIR` to point elsewhere, or clone
  github.com/ArkLabsHQ/arkade-regtest.
- **Not** a Lightning setup: sub-dust / LN receive is out of scope here (needs
  the custom sub-dust Boltz + two LN nodes + a channel). Unilateral exit uses
  only arkd + esplora, so none of that matters for this drill.

## You are the miner

regtest = you own the chain. `regtest.mjs` wraps the primitives:

```bash
cd $REGTEST_DIR   # e.g. ../ts-sdk/regtest
node regtest.mjs mine 1            # mine 1 block (advance the tip)
node regtest.mjs mine 20           # mine 20 — how you elapse a block CSV
node regtest.mjs faucet <addr> 1   # send 1 BTC onchain from the node wallet
node regtest.mjs faucet <addr> 0.01 --confirm   # …and mine it in
node regtest.mjs ark balance       # the pre-seeded ark client's offchain funds
node regtest.mjs rpc getblockcount # bitcoin-cli passthrough
```

The auto-miner is **off** in this drill (`AUTOMINE_INTERVAL=0`, set by env.sh):
the CSV exit delay is block-denominated (20 blocks), so you advance it
deliberately with `mine`. If background blocks kept coming they could fire the
ASP's own sweep mid-drill and race your exit.

## Why the CSV is fast here

arkd reads its locktimes by magnitude: values < 512 mean **blocks** (regtest
only) and arkd switches to a block-height scheduler. env.sh sets
`ARKD_UNILATERAL_EXIT_DELAY=20`, so a VTXO's exit CSV is 20 blocks — elapse it
with `node regtest.mjs mine 20` instead of waiting ~a day of wall-clock. (On
mainnet the same delay is seconds/time-based; arkd rejects block values off
regtest.)

## Data isolation

The drill bridge runs from `regtest-e2e/runtime/` with its own
`data/bridge-regtest.sqlite` and `data/config.json`. It never touches your real
`./data/bridge.sqlite`. `down.sh` deletes the runtime dir so nothing lingers.

## Drill

### 1. Bring up + start the bridge

```bash
regtest-e2e/up.sh
# then, in a second terminal (foreground so you see logs):
cd regtest-e2e/runtime && bun run <bridge-repo>/src/index.ts
```

`up.sh` prints the exact start command with the paths filled in.

### 2. Setup + fund

- Open http://127.0.0.1:4282 → `/setup` → **Generate** a fresh nsec (throwaway).
- Copy the **Ark address** from the dashboard.
- Fund it with a VTXO:
  ```bash
  regtest-e2e/fund.sh <ark-address> 100000
  ```
- Watch: the dashboard **Balance** and **Exit readiness** tiles update over SSE;
  the bridge log shows `exit-sync: 1 vtxo(s) mirrored (funds-activity)`. The
  vault now holds the VTXO's pre-signed proofs.

Optionally build a deeper chain (higher exit cost, more stepper rows) by sending
a few offchain payments between fundings before exiting.

### 3. Kill the ASP → degraded boot

```bash
cd $REGTEST_DIR && docker compose stop arkd     # or: node regtest.mjs stop arkd
```

Restart the bridge (Ctrl-C, then the same start command). It boots into
**degraded** mode — `/` shows the red status page with vault readiness and the
exit-fuel address; the exit tab still works, everything else bounces there.
This is the emergency the whole feature exists for.

### 4. Fund the exit fuel

The `/exit` detail page (and the degraded page) show the **exit-fuel address**
(the nsec-derived P2TR). It needs onchain sats to pay CPFP fees:

```bash
regtest-e2e/fund.sh   # no — that's for VTXOs; fund the P2TR onchain instead:
cd $REGTEST_DIR && node regtest.mjs faucet <exit-fuel-address> 0.01 --confirm
```

The funding panel's balance updates; the low-fuel warning clears once it covers
the estimate.

### 5. Exit a VTXO

- `/exit` → pick a VTXO → open its detail page. Read the cost (tx count, vB,
  sats, % of value) and the verdict.
- **Start exit.** The engine broadcasts the pre-signed chain as 1P1C packages.
- **Mine** so the broadcasts confirm:
  ```bash
  node regtest.mjs mine 1     # repeat as the stepper advances; each broadcast
                              # needs a block to confirm before the next
  ```
  The stepper walks commitment → tree/checkpoint/ark → the VTXO tx, each
  flipping 🕐 mempool → ✅ confirmed.

### 6. Wait out the CSV, then sweep

- Once fully unrolled the op is **waiting**; the stepper shows `CSV wait —
  n/20 blocks`.
- Elapse it:
  ```bash
  node regtest.mjs mine 20
  ```
- The op flips to **sweepable** (the engine's 60s poll, or reload). **Sweep now**
  on the detail page → mine 1 to confirm. The op goes **swept** with the sweep
  txid; the funds are now on the plain P2TR you alone control.

Verify onchain:
```bash
node regtest.mjs rpc gettxout <sweep-txid> 0
```

### 7. Tear down

```bash
# Ctrl-C the bridge, then:
regtest-e2e/down.sh          # stop, keep volumes
regtest-e2e/down.sh --clean  # stop + wipe the chain for a fresh next run
```

## Troubleshooting

- **A broadcast won't confirm** — `mine 1`. Zero-fee parents only enter a block
  once their CPFP child pays; if the fuel address is empty, top it up (step 4).
- **Op stuck at `unrolling`** — check the bridge log for the broadcast error; a
  `no proof for tx …` means the vault didn't mirror that ancestor (was arkd
  killed before ProofSync caught up?). Re-run against a VTXO funded while arkd
  was alive.
- **Exit tab empty in degraded mode** — the vault had no mirrored VTXOs before
  arkd died. Fund + confirm sync (step 2) before killing arkd.
