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

## Two modes (`EXIT_DRILL_MODE`)

arkd reads locktimes by magnitude: `>= 512` = seconds (time scheduler), `< 512`
= blocks (regtest only). env.sh picks one:

- **`seconds` (default)** — the realistic mode. Tree expiry is a real 1-day
  timestamp, so the bridge's auto-renew never fires and the funding VTXO stays
  put: you can **build tree depth** by sending offchain payments without arkd
  re-treeing it away. The exit CSV is **512 s (~8.5 min)** — the BIP68 floor
  (time locktimes come in 512-second units, so 3 min isn't expressible). The
  auto-miner runs every 30 s, so broadcasts confirm promptly and the CSV
  **elapses on its own** (block MedianTimePast tracks real time) — no manual
  mining for the wait.
- **`blocks` (`EXIT_DRILL_MODE=blocks up.sh`)** — the fast mode. Exit CSV is 20
  blocks, elapsed instantly with `mine 20`, auto-miner off. But block mode makes
  arkd report a bogus near-now expiry, so the bridge auto-renews constantly
  (re-tree churn) and the UI countdown false-flags "expired". Fine for a quick
  single-VTXO smoke; bad for building depth.

Pick seconds for a realistic deep-tree exit; blocks for a 30-second smoke.

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

**Building tree depth** (higher exit cost, more stepper rows) — do this in
**seconds mode** so arkd doesn't re-tree the VTXO away while you work. Depth is
the VTXO's own offchain history: each offchain send adds a checkpoint+ark hop to
its chain (sending to a *fresh* address just makes a new shallow VTXO — it's the
same funds hopping that deepens). Ark blocks self-sends, so ping-pong the funds
between the pre-seeded `ark` client and the bridge:

```bash
cd $REGTEST_DIR   # e.g. ../ts-sdk/regtest

# the ark client's own address, so the bridge can send back to it
node regtest.mjs ark receive              # prints an ark1… / tark1… address

# ark client → bridge  (this direction; --password avoids the tty prompt)
node regtest.mjs ark send --to <bridge-ark-addr> --amount 50000 --password secret
```

Then the other leg, **bridge → ark client**, from the bridge UI: open
http://127.0.0.1:4282/send, paste the ark client's address (from `ark receive`),
send Ark. Bounce it back and forth a handful of times — each round-trip adds
depth to that VTXO's chain. Leave it at the bridge, then exit it (steps 3–6) and
watch the stepper show the deeper chain and higher cost. (The official web wallet
at :3003 could be the second wallet too, but its delegate-info fetch is broken in
this regtest — the `ark` CLI ping-pong needs nothing extra.)

### 3. Kill the ASP → degraded boot

First **confirm the last settlement round** — mine a block so the funding
VTXO's commitment is on-chain, not left unconfirmed in the mempool. Exit
broadcasts the tree *on top of* the commitment, so an unconfirmed commitment
makes the 1P1C package fail with a silent missing-input rejection (the engine
just retries in a loop). One block settles it:

```bash
cd $REGTEST_DIR && node regtest.mjs mine 1
```

Then stop arkd. While arkd is alive it keeps re-treeing the VTXO into new
outpoints every round, so an exit started against a stale outpoint fails with
"no chain for this vtxo" — killing arkd freezes the VTXO, which is the whole
point of unilateral exit:

```bash
docker compose -p arkade-regtest stop arkd      # freezes the VTXO
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
- The broadcasts need blocks to confirm (each level before the next). In
  **seconds mode** the 30s auto-miner does this for you — just watch. In
  **blocks mode**, mine manually as the stepper advances:
  ```bash
  node regtest.mjs mine 1     # repeat per broadcast
  ```
  The stepper walks commitment → tree/checkpoint/ark → the VTXO tx, each
  flipping 🕐 mempool → ✅ confirmed.

### 6. Wait out the CSV, then sweep

Once fully unrolled the op is **waiting**; the stepper shows the CSV countdown.

- **seconds mode (default):** wait ~8.5 min — the auto-miner advances the chain,
  so the CSV elapses on its own. Nothing to do but wait (and keep the fuel
  address funded; the auto-miner also confirms your broadcasts).
- **blocks mode:** elapse it instantly by mining:
  ```bash
  node regtest.mjs mine 20
  ```

The op flips to **sweepable** (the engine's 60s poll, or reload the page).
**Sweep now** on the detail page. In seconds mode the auto-miner confirms it; in
blocks mode `mine 1`. The op goes **swept** with the sweep txid; the funds are
now on the plain P2TR you alone control.

Verify onchain:
```bash
node regtest.mjs rpc gettxout <sweep-txid> 0
```

### Boost drill (automated, no browser)

`regtest-e2e/boost-drill.sh` is the existence proof for the fee re-boost
(EXIT_DESIGN §5 Boost): it runs the whole exit flow above unattended in
**blocks mode** — where nothing mines, so the first 1P1C package is stuck in
the mempool *by construction* — then boosts it and verifies against bitcoind
directly that the old CPFP child was evicted, the replacement is in with a
higher fee, and the parent never moved. The sweep leg repeats the trick:
sweep, leave it stuck, boost-sweep, verify the RBF, mine it in. The fuel P2TR
deliberately gets ONE confirmed coin so the boost must reclaim the stuck
child's own prevout (the hard path). ~4 minutes, exit code 0 = proven.
First green run 2026-07-12: child 278 sats → 433 sats, sweep 148 → 287, both
replacements accepted by bitcoind.

```bash
regtest-e2e/boost-drill.sh   # brings the stack up itself (wipes previous)
```

### 7. Tear down

The bridge is a plain `bun` process, separate from the docker stack — `down.sh`
stops the containers but NOT the bridge. If you started it in the foreground
(step 1), just Ctrl-C it. If it's running in the background, kill it by port:

```bash
lsof -ti tcp:4282 | xargs kill      # stop the bridge process
regtest-e2e/down.sh                 # stop the stack, keep volumes
regtest-e2e/down.sh --clean         # stop + wipe the chain for a fresh run
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
