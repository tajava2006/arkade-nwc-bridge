#!/usr/bin/env bash
# Bring up the arkade-regtest stack and prepare an ISOLATED bridge runtime
# pointed at it. Does NOT start the bridge — that's a separate step so you can
# run it in the foreground and watch logs (see the printed instructions / the
# RUNBOOK). EXIT_PLAN.md #15.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

# Always start from a pristine slate. arkade-regtest's `start` isn't
# idempotent on leftover volumes — a plain re-run over a previous run's
# docker volumes fails at "Bitcoin Core wallet (created) did not become ready
# in time". Each exit drill consumes its chain (you exit + sweep VTXOs) so
# there's nothing to resume anyway; wipe the chain volumes AND the stale
# bridge runtime (old regtest account/vault) so every up.sh is a clean drill.
echo "▶ wiping any previous stack + bridge runtime for a fresh drill…"
regtest clean >/dev/null 2>&1 || true
rm -rf "${RUNTIME_DIR}"

# Both profiles: `ark` is all the exit feature needs, but the bridge requires
# a reachable Boltz at boot (getFees), so `boltz` must be up too — its REST
# comes up without LN channels, which is all boot needs. We never make an LN
# swap in this drill (that needs channels; out of scope — RUNBOOK).
echo "▶ starting arkade-regtest (ark + boltz profiles, ${EXIT_DRILL_MODE} mode)…"
echo "  regtest dir: ${REGTEST_DIR}"
if [ "${EXIT_DRILL_MODE}" = "seconds" ]; then
  echo "  seconds mode: no re-tree churn (good for building tree depth), CSV ~8.5 min hands-off"
else
  echo "  blocks mode: fast CSV via 'mine 20', but re-tree churn (single-VTXO smoke only)"
fi
regtest start --profile ark --profile boltz

echo "▶ waiting for arkd at ${ARKD_URL}…"
for i in $(seq 1 60); do
  if curl -fsS --max-time 3 "${ARKD_URL}/v1/info" >/dev/null 2>&1; then
    echo "  arkd is up"
    break
  fi
  [ "$i" = 60 ] && { echo "  arkd did not come up in time"; exit 1; }
  sleep 2
done

net=$(curl -fsS "${ARKD_URL}/v1/info" | grep -o '"network":"[a-z]*"' || true)
echo "  arkd info: ${net}"

# Isolated bridge runtime. dbPath is relative to the bridge's cwd, which up.sh
# sets to RUNTIME_DIR when it prints the start command — so the sqlite lands in
# RUNTIME_DIR/data, never in the operator's real ./data.
mkdir -p "${RUNTIME_DIR}/data"
cat > "${RUNTIME_DIR}/data/config.json" <<JSON
{
  "network": "regtest",
  "arkServerUrl": "${ARKD_URL}",
  "boltzApiUrl": "${BOLTZ_URL}",
  "esploraUrls": ["${ESPLORA_URL}"],
  "dbPath": "./data/bridge-regtest.sqlite"
}
JSON
echo "▶ wrote isolated bridge config → ${RUNTIME_DIR}/data/config.json"

cat <<EOF

✅ regtest is up. Now start the bridge in its isolated runtime:

    cd "${RUNTIME_DIR}" && bun run "${BRIDGE_REPO}/src/index.ts"

Then open http://127.0.0.1:4282 and complete /setup (generate a fresh nsec —
this is a throwaway regtest account). Fund it with a VTXO once you have the
Ark address from the dashboard:

    "${BRIDGE_REPO}/regtest-e2e/fund.sh" <ark-address-from-dashboard> [sats]

Drill steps, mining, and the degraded-exit flow: regtest-e2e/RUNBOOK.md
Tear it all down with:  regtest-e2e/down.sh
EOF
