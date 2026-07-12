#!/usr/bin/env bash
# Shared settings for the unilateral-exit regtest e2e (EXIT_PLAN.md #15).
# Sourced by up.sh / down.sh / fund.sh — not run directly.

set -euo pipefail

# The bridge runs from its OWN runtime dir so its ./data never coincides with
# the operator's real bridge data or the dev checkout's ./data — the regtest
# account/seed and sqlite live only here (EXIT_PLAN #15, isolation ask).
BRIDGE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${BRIDGE_REPO}/regtest-e2e/runtime"

# Where arkade-regtest (github.com/ArkLabsHQ/arkade-regtest) lives. Resolution
# order, all CWD-independent (anchored on THIS script's location):
#   1. REGTEST_DIR — explicit override for any custom setup.
#   2. This repo's own submodule (regtest-e2e/arkade-regtest) if initialized —
#      the standalone path; the pin is the commit the drill was validated on.
#   3. The operator workspace's sibling ts-sdk clone (which carries the same
#      repo as ITS regtest/ submodule), incl. a worktree nested under
#      .worktrees/ — so dev checkouts don't clone a duplicate.
#   4. Auto-`git submodule update --init` of (2) — makes a fresh standalone
#      clone work with no extra step (needs network once).
LOCAL_REGTEST="${BRIDGE_REPO}/regtest-e2e/arkade-regtest"
if [ -z "${REGTEST_DIR:-}" ]; then
  for cand in \
    "${LOCAL_REGTEST}" \
    "${BRIDGE_REPO}/../ts-sdk/regtest" \
    "${BRIDGE_REPO}/../../../ts-sdk/regtest" \
    "${BRIDGE_REPO}/../../ts-sdk/regtest"; do
    if [ -f "${cand}/regtest.mjs" ]; then REGTEST_DIR="${cand}"; break; fi
  done
fi
if [ -z "${REGTEST_DIR:-}" ]; then
  echo "▶ arkade-regtest not found — initializing the submodule (one-time)…" >&2
  if git -C "${BRIDGE_REPO}" submodule update --init regtest-e2e/arkade-regtest >&2 \
     && [ -f "${LOCAL_REGTEST}/regtest.mjs" ]; then
    REGTEST_DIR="${LOCAL_REGTEST}"
  else
    echo "✗ could not set up arkade-regtest. Either:" >&2
    echo "    git -C '${BRIDGE_REPO}' submodule update --init regtest-e2e/arkade-regtest" >&2
    echo "  or clone github.com/ArkLabsHQ/arkade-regtest anywhere and set REGTEST_DIR." >&2
    exit 1
  fi
fi

# Regtest service endpoints (arkade-regtest defaults — README "Service URLs").
ARKD_URL="http://localhost:7070"
ESPLORA_URL="http://localhost:3000/api"
BOLTZ_URL="http://localhost:9069"

# arkd interprets locktimes by magnitude: values >= 512 are SECONDS (time
# scheduler), < 512 are BLOCKS (regtest only, rejected elsewhere). All five
# must share one type or arkd refuses to start. regtest.mjs's loadEnv only
# fills UNSET vars, so these inline exports win over the submodule .env.regtest.
#
# Two modes, toggled by EXIT_DRILL_MODE (default: seconds).
#
# seconds (default) — the realistic mode. Tree expiry is a real 1-day
#   timestamp, so the bridge's auto-renew (settlementConfig vtxoThreshold =
#   3600s, fires within 1h of expiry) never triggers — the funding VTXO stays
#   put, so you can build tree DEPTH by sending offchain payments without arkd
#   re-treeing it out from under you. The exit CSV is 512s (~8.5 min) — the
#   BIP68 floor (time locktimes are quantised to 512s units, so 3 min isn't
#   expressible; 512s is the shortest). Auto-miner ON at 30s so blocks keep
#   coming: broadcasts confirm promptly AND the block MedianTimePast advances
#   in real time, which is what actually elapses a relative-time CSV — so the
#   ~8.5 min wait passes hands-off, no manual mining. A 1-day tree expiry means
#   the auto-miner can't fire an ASP sweep mid-drill either.
#
# blocks — the fast mode (EXIT_DRILL_MODE=blocks). Exit CSV is 20 blocks,
#   elapsed instantly with `mine 20`; auto-miner OFF. Trade-off: arkd reports a
#   bogus near-now batchExpiry timestamp in block mode, which makes the bridge
#   auto-renew constantly (re-treeing churn) and the UI countdown false-flag
#   "expired" (EXIT_PLAN #15 finding C). Fine for a quick single-VTXO exit
#   smoke, bad for building depth.
EXIT_DRILL_MODE="${EXIT_DRILL_MODE:-seconds}"
if [ "${EXIT_DRILL_MODE}" = "blocks" ]; then
  export ARKD_VTXO_TREE_EXPIRY=500
  export ARKD_UNILATERAL_EXIT_DELAY=20
  export ARKD_PUBLIC_UNILATERAL_EXIT_DELAY=20
  export ARKD_BOARDING_EXIT_DELAY=30
  export ARKD_CHECKPOINT_EXIT_DELAY=10
  export AUTOMINE_INTERVAL=0
else
  # arkd (settings.go) requires: all delays same type (>=512 = seconds),
  # public >= unilateral, and unilateral != boarding. So boarding is 1024,
  # not 512 — everything else stays at the 512s floor.
  export ARKD_VTXO_TREE_EXPIRY=86400          # ~1 day — no auto-renew churn
  export ARKD_UNILATERAL_EXIT_DELAY=512        # ~8.5 min CSV (BIP68 floor)
  export ARKD_PUBLIC_UNILATERAL_EXIT_DELAY=512 # must be >= unilateral
  export ARKD_BOARDING_EXIT_DELAY=1024         # must differ from unilateral
  export ARKD_CHECKPOINT_EXIT_DELAY=512
  export AUTOMINE_INTERVAL=30                  # MTP advances → CSV self-elapses
fi

regtest() {
  ( cd "${REGTEST_DIR}" && node regtest.mjs "$@" )
}
