#!/usr/bin/env bash
# Tear down the regtest e2e. Stops the stack and removes the isolated bridge
# runtime so no regtest config/sqlite lingers. Pass --clean to also wipe the
# arkade-regtest volumes (fresh chain next time). EXIT_PLAN.md #15.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

echo "▶ stop the bridge process yourself first (Ctrl-C in its terminal)."

if [ "${1:-}" = "--clean" ]; then
  echo "▶ regtest clean (wipes chain + volumes)…"
  regtest clean
else
  echo "▶ regtest stop (keeps volumes; use --clean to wipe)…"
  regtest stop
fi

if [ -d "${RUNTIME_DIR}" ]; then
  echo "▶ removing isolated bridge runtime ${RUNTIME_DIR}"
  rm -rf "${RUNTIME_DIR}"
fi
echo "✅ down."
