# upstream-swap-e2e — solver feasibility tests (SM-10/11/12)

These run from an **upstream ts-sdk checkout** (they import `../../src` of `packages/swap`), not
from this repo: copy them into `packages/swap/test/e2e/` of `arkade-os/ts-sdk` master and bring up
its RFQ regtest stack with our fork arkd images (`scripts/regtest.sh swap-rfq`), our emulator key,
and our patched intent-solver (my-server `SOLVER_MIGRATION_PLAN.md` SM-10/SM-11).

- `rfqRealLnBothWays.test.ts` — protocol-level, real intent-solver + LND: send, failed send
  (immediate covenant refund), receive. `EMULATOR_PUBKEY_OVERRIDE=<ours>`;
  `EXPECT_EMULATOR_MISMATCH=1` runs only the "client forgot the override → AddressMismatch" check.
- `rfqHighLevelOurSolver.test.ts` — the client the bridge will use: `createSwapClient` with only
  our solver's card (`discover({ registries: [] })` → `discovery.snapshot`), an HTTP transport
  attested to the card's discovery key, our emulator key; fails on any non-localhost fetch.
  `SOLVER_CARD_PATH=<our card json>`.

They seed the SM-52 drills (rewritten against the bridge itself).
