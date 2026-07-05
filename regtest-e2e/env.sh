#!/usr/bin/env bash
# Shared settings for the unilateral-exit regtest e2e (EXIT_PLAN.md #15).
# Sourced by up.sh / down.sh / fund.sh — not run directly.

set -euo pipefail

# Where the arkade-regtest checkout lives. Default assumes the operator
# workspace layout (sibling ../ts-sdk/regtest submodule); override for any
# other setup, or clone github.com/ArkLabsHQ/arkade-regtest and point here.
REGTEST_DIR="${REGTEST_DIR:-../../../ts-sdk/regtest}"

# The bridge runs from its OWN runtime dir so its ./data never coincides with
# the operator's real bridge data or the dev checkout's ./data — the regtest
# account/seed and sqlite live only here (EXIT_PLAN #15, isolation ask).
BRIDGE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${BRIDGE_REPO}/regtest-e2e/runtime"

# Regtest service endpoints (arkade-regtest defaults — README "Service URLs").
ARKD_URL="http://localhost:7070"
ESPLORA_URL="http://localhost:3000/api"
BOLTZ_URL="http://localhost:9069"

# Block-denominated locktimes so unilateral-exit CSV elapses by MINING, not by
# waiting wall-clock time (arkd auto-selects the block scheduler for values
# < 512; rejected on non-regtest). Auto-miner OFF so background blocks can't
# advance the tip and fire ASP sweeps mid-drill. regtest.mjs's loadEnv only
# fills UNSET vars, so these inline values win over the submodule's own
# .env.regtest.
#
# Exit delay 20 = a VTXO's exit CSV is 20 blocks (elapse with `mine 20`). Tree
# expiry is deliberately LARGE (500) even though it's block-denominated: the
# drill's boltz channel setup mines ~10 blocks and you mine ~20 more for the
# CSV, so a short tree expiry (arkd's e2e default is 40) would sweep the
# funding VTXO out from under the drill. All values must share the same type
# (all blocks here); arkd refuses a mismatch. 500 tree ≫ 20 exit keeps the
# funding VTXO alive across the whole drill while CSV still elapses fast.
export ARKD_VTXO_TREE_EXPIRY=500
export ARKD_UNILATERAL_EXIT_DELAY=20
export ARKD_PUBLIC_UNILATERAL_EXIT_DELAY=20
export ARKD_BOARDING_EXIT_DELAY=30
export ARKD_CHECKPOINT_EXIT_DELAY=10
export AUTOMINE_INTERVAL=0

regtest() {
  ( cd "${REGTEST_DIR}" && node regtest.mjs "$@" )
}
