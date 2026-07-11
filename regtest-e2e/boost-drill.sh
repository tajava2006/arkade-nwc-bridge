#!/usr/bin/env bash
# Fee re-boost drill — the one thing exit_boost.test.ts can only mock: does a
# REAL bitcoind accept our RBF child replacement (same anchor, higher fee,
# package resubmit with the parent already in the mempool), and the sweep RBF?
#
# Fully automated, no browser. Blocks mode on purpose: the auto-miner is OFF,
# so a broadcast 1P1C package sits stuck in the mempool by construction —
# exactly the state the boost exists for. The fuel P2TR gets ONE confirmed
# coin, so the boost is forced through the hard path: the stuck child sits on
# that coin (esplora hides it), and the replacement must reclaim the prevout
# of the tx it replaces.
#
# Sequence: stack up → setup → fund VTXO → kill arkd → degraded boot → fuel →
# start exit → package stuck → BOOST → verify old child evicted / new child
# in, higher fee → mine the unroll out → CSV 20 blocks → sweep (stuck) →
# BOOST-SWEEP → verify → confirm. Teardown stays manual (down.sh), same as
# the RUNBOOK drill.

set -euo pipefail
export EXIT_DRILL_MODE=blocks
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

BRIDGE_URL="http://127.0.0.1:4282"
DB="${RUNTIME_DIR}/data/bridge-regtest.sqlite"
LOG="${RUNTIME_DIR}/bridge.log"

step() { echo; echo "▶ $*"; }
die() {
  echo "✗ FAIL: $*" >&2
  echo "--- last bridge log lines ---" >&2
  tail -30 "$LOG" 2>/dev/null >&2 || true
  exit 1
}

sq() { sqlite3 "$DB" "$1"; }
rpc() { regtest rpc "$@"; }

# wait_until <timeout_s> <desc> <shell-expr…>  — polls 1/s
wait_until() {
  local t=$1 desc=$2; shift 2
  for _ in $(seq 1 "$t"); do
    if eval "$*" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "timeout waiting for: $desc"
}

start_bridge() {
  ( cd "${RUNTIME_DIR}" && nohup bun run "${BRIDGE_REPO}/src/index.ts" >> "$LOG" 2>&1 & )
  wait_until 30 "bridge http" "curl -fsS -o /dev/null '$BRIDGE_URL/setup' || curl -fsS -o /dev/null '$BRIDGE_URL/'"
}
stop_bridge() {
  lsof -ti tcp:4282 | xargs kill 2>/dev/null || true
  sleep 1
}

# the mempool tx that CPFPs $1 (has it in depends) — the current anchor child
child_of() {
  local parent=$1 txid
  for txid in $(rpc getrawmempool | jq -r '.[]'); do
    [ "$txid" = "$parent" ] && continue
    if rpc getmempoolentry "$txid" | jq -e --arg p "$parent" '.depends | index($p)' >/dev/null; then
      echo "$txid"
      return 0
    fi
  done
  return 1
}

fee_of() { rpc getmempoolentry "$1" | jq -r '.fees.base'; }

step "0. preflight — kill any leftover bridge"
stop_bridge

step "1. stack up (blocks mode: auto-miner OFF, CSV = 20 blocks)"
"${BRIDGE_REPO}/regtest-e2e/up.sh"

step "2. bridge up + /setup (throwaway nsec)"
: > "$LOG" 2>/dev/null || true
start_bridge
curl -fsS -X POST -d 'mode=generate' -o /dev/null "$BRIDGE_URL/setup"
wait_until 60 "ready mode (ark address on dashboard)" \
  "curl -fsS '$BRIDGE_URL/' | grep -qE '(t?ark)1[a-zA-Z0-9]{50,}'"
ARK_ADDR=$(curl -fsS "$BRIDGE_URL/" | grep -oE '(t?ark)1[a-zA-Z0-9]{50,}' | head -1)
echo "  ark address: ${ARK_ADDR:0:24}…"

step "3. fund a VTXO + wait for the vault mirror"
"${BRIDGE_REPO}/regtest-e2e/fund.sh" "$ARK_ADDR" 100000
wait_until 60 "vault mirror" "[ -n \"\$(sq 'SELECT 1 FROM exit_vtxos LIMIT 1;')\" ]"
regtest mine 1   # commitment must be onchain before the tree broadcasts (finding B)

step "4. kill arkd → degraded boot (freezes the VTXO)"
( cd "${REGTEST_DIR}" && docker compose -p arkade-regtest stop arkd )
stop_bridge
start_bridge
curl -fsS "$BRIDGE_URL/" | grep -qi 'degraded' || echo "  (warn: degraded marker not found on /)"
IFS='|' read -r TXID VOUT <<< "$(sq 'SELECT txid, vout FROM exit_vtxos ORDER BY synced_at DESC, rowid DESC LIMIT 1;')"
[ -n "${TXID:-}" ] || die "no vtxo in the vault"
echo "  exit target: ${TXID:0:16}…:${VOUT}"

step "5. fund the exit fuel P2TR (ONE confirmed coin — forces prevout reclaim on boost)"
FUEL_ADDR=$(curl -fsS "$BRIDGE_URL/exit" | grep -oE 'bcrt1p[a-z0-9]{38,}' | head -1)
[ -n "$FUEL_ADDR" ] || die "no fuel address on /exit"
echo "  fuel: $FUEL_ADDR"
regtest faucet "$FUEL_ADDR" 0.01 --confirm
# the engine reads fuel through esplora — start the exit only once the coin
# is INDEXED there, or bumpP2A sees an empty wallet ("Insufficient funds").
# A human hits this ordering naturally (the funding panel shows the balance
# before they click); the script has to wait for it explicitly.
wait_until 60 "fuel coin indexed by esplora" \
  "curl -fsS '${ESPLORA_URL}/address/${FUEL_ADDR}/utxo' | jq -e '.[0].status.confirmed'"

step "6. start exit — first 1P1C package broadcasts and STICKS (nobody mines)"
curl -fsS -X POST -o /dev/null "$BRIDGE_URL/exit/$TXID/$VOUT/start"
wait_until 60 "first broadcast recorded" "[ -n \"\$(sq 'SELECT 1 FROM exit_broadcasts LIMIT 1;')\" ]"
STEP_TXID=$(sq "SELECT step_txid FROM exit_broadcasts ORDER BY created_at DESC LIMIT 1;")
wait_until 30 "package in mempool" "rpc getrawmempool | jq -e --arg t '$STEP_TXID' 'index(\$t)'"
OLD_CHILD=$(child_of "$STEP_TXID") || die "no CPFP child found for $STEP_TXID"
OLD_FEE=$(fee_of "$OLD_CHILD")
# boost reads the stuck child (fee/prevouts) through esplora — wait for BOTH
# its indexes: the tx index (/tx) and the address index (/address/:a/txs, the
# anchor-spender fallback since this backend omits outspend txids). They lag
# independently; boosting in between trips the blind-boost guard (which is
# the guard doing its job — a human just clicks again).
wait_until 60 "stuck child indexed by esplora (tx index)" \
  "curl -fsS '${ESPLORA_URL}/tx/${OLD_CHILD}' | jq -e '.fee'"
wait_until 60 "stuck child indexed by esplora (address index)" \
  "curl -fsS '${ESPLORA_URL}/address/${FUEL_ADDR}/txs' | jq -e --arg t '$OLD_CHILD' '.[] | select(.txid == \$t)'"
echo "  stuck package: parent ${STEP_TXID:0:16}… + child ${OLD_CHILD:0:16}… (fee $OLD_FEE BTC)"

step "7. BOOST — replace the CPFP child via RBF"
HTTP=$(curl -sS -X POST -o "${RUNTIME_DIR}/boost-response.html" -w '%{http_code}' \
  "$BRIDGE_URL/exit/$TXID/$VOUT/boost/$STEP_TXID")
[ "$HTTP" = 303 ] || die "boost returned HTTP $HTTP: $(cat "${RUNTIME_DIR}/boost-response.html")"
wait_until 15 "old child evicted" "! rpc getrawmempool | jq -e --arg t '$OLD_CHILD' 'index(\$t)'"
rpc getrawmempool | jq -e --arg t "$STEP_TXID" 'index($t)' >/dev/null || die "parent fell out of the mempool"
NEW_CHILD=$(child_of "$STEP_TXID") || die "no replacement child in mempool"
[ "$NEW_CHILD" != "$OLD_CHILD" ] || die "child was not replaced"
NEW_FEE=$(fee_of "$NEW_CHILD")
jq -en --argjson a "$OLD_FEE" --argjson b "$NEW_FEE" '$b > $a' >/dev/null || die "new fee $NEW_FEE not > old $OLD_FEE"
echo "  ✅ bitcoind ACCEPTED the replacement:"
echo "     old child ${OLD_CHILD:0:16}… fee $OLD_FEE BTC → evicted"
echo "     new child ${NEW_CHILD:0:16}… fee $NEW_FEE BTC → in mempool, parent untouched"

step "8. mine the boosted package in; walk the rest of the unroll"
for _ in $(seq 1 40); do
  state=$(sq "SELECT state FROM exit_ops WHERE txid='$TXID' AND vout=$VOUT;")
  [ "$state" = "waiting" ] && break
  regtest mine 1 >/dev/null
  sleep 3
done
[ "$(sq "SELECT state FROM exit_ops WHERE txid='$TXID' AND vout=$VOUT;")" = "waiting" ] \
  || die "unroll did not reach 'waiting'"
echo "  fully unrolled — CSV clock running"

step "9. elapse the CSV (mine 20) → sweepable (bridge restart = immediate re-check)"
regtest mine 20
stop_bridge
start_bridge
wait_until 90 "sweepable" \
  "[ \"\$(sq \"SELECT state FROM exit_ops WHERE txid='$TXID' AND vout=$VOUT;\")\" = sweepable ]"

step "10. sweep — and it sticks too (nobody mines)"
curl -fsS -X POST -o /dev/null "$BRIDGE_URL/exit/$TXID/$VOUT/sweep"
OLD_SWEEP=$(sq "SELECT sweep_txid FROM exit_ops WHERE txid='$TXID' AND vout=$VOUT;")
wait_until 15 "sweep in mempool" "rpc getrawmempool | jq -e --arg t '$OLD_SWEEP' 'index(\$t)'"
OLD_SWEEP_FEE=$(fee_of "$OLD_SWEEP")
# boost-sweep reads the old sweep's fee (the RBF floor) through esplora — an
# unindexed tx would mean no floor and a doomed same-fee replacement
wait_until 60 "stuck sweep indexed by esplora" \
  "curl -fsS '${ESPLORA_URL}/tx/${OLD_SWEEP}' | jq -e '.fee'"
echo "  stuck sweep ${OLD_SWEEP:0:16}… (fee $OLD_SWEEP_FEE BTC)"

step "11. BOOST-SWEEP — RBF the sweep itself"
HTTP=$(curl -sS -X POST -o "${RUNTIME_DIR}/boost-sweep-response.html" -w '%{http_code}' \
  "$BRIDGE_URL/exit/$TXID/$VOUT/boost-sweep")
[ "$HTTP" = 303 ] || die "boost-sweep returned HTTP $HTTP: $(cat "${RUNTIME_DIR}/boost-sweep-response.html")"
NEW_SWEEP=$(sq "SELECT sweep_txid FROM exit_ops WHERE txid='$TXID' AND vout=$VOUT;")
[ "$NEW_SWEEP" != "$OLD_SWEEP" ] || die "sweep txid did not change"
wait_until 15 "old sweep evicted" "! rpc getrawmempool | jq -e --arg t '$OLD_SWEEP' 'index(\$t)'"
rpc getrawmempool | jq -e --arg t "$NEW_SWEEP" 'index($t)' >/dev/null || die "new sweep not in mempool"
NEW_SWEEP_FEE=$(fee_of "$NEW_SWEEP")
jq -en --argjson a "$OLD_SWEEP_FEE" --argjson b "$NEW_SWEEP_FEE" '$b > $a' >/dev/null \
  || die "new sweep fee $NEW_SWEEP_FEE not > old $OLD_SWEEP_FEE"
CARRIED=$(sq "SELECT tip_height FROM exit_broadcasts WHERE step_txid='$NEW_SWEEP';")
echo "  ✅ sweep RBF ACCEPTED: ${OLD_SWEEP:0:16}… ($OLD_SWEEP_FEE) → ${NEW_SWEEP:0:16}… ($NEW_SWEEP_FEE)"
echo "     broadcast-height record carried to replacement: tip_height=$CARRIED"

step "12. confirm the boosted sweep onchain"
regtest mine 1
rpc gettxout "$NEW_SWEEP" 0 | jq -e '.value' >/dev/null || die "swept output not found onchain"
echo "  swept output confirmed: $(rpc gettxout "$NEW_SWEEP" 0 | jq -r '.value') BTC on the fuel/dest P2TR"

echo
echo "✅✅ BOOST DRILL PASSED — real bitcoind accepted both RBF replacements."
echo "   Tear down: lsof -ti tcp:4282 | xargs kill; regtest-e2e/down.sh --clean"
