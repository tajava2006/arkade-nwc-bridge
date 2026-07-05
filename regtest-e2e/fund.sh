#!/usr/bin/env bash
# Fund the bridge with an offchain VTXO by sending from the regtest ark client
# (pre-seeded with offchain funds by `regtest start`). Give it the bridge's
# Ark address (shown on the dashboard) and an optional sat amount.
# EXIT_PLAN.md #15.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ADDR="${1:-}"
SATS="${2:-100000}"
# ark send needs the client wallet password (arkade-regtest sets it to
# ARKD_PASSWORD, default 'secret'); passing it here avoids the interactive
# prompt that fails under a non-tty ("inappropriate ioctl for device").
ARK_PW="${ARKD_PASSWORD:-secret}"
if [ -z "${ADDR}" ]; then
  echo "usage: fund.sh <bridge-ark-address> [sats]" >&2
  exit 1
fi

echo "▶ ark client balance before:"
regtest ark balance || true

echo "▶ sending ${SATS} sats offchain → ${ADDR}"
regtest ark send --to "${ADDR}" --amount "${SATS}" --password "${ARK_PW}"

echo "▶ mining 1 block to settle any pending round"
regtest mine 1

echo "✅ sent. The bridge's ContractWatcher should see it within seconds; the"
echo "   dashboard balance and the Exit readiness tile update over SSE, and"
echo "   ProofSync mirrors the new VTXO's proofs into the vault."
