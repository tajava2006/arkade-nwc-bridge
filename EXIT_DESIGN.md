# EXIT_DESIGN.md — unilateral exit

The bridge's second differentiator (after sub-dust LN): a GUI path for
**unilateral exit** — pulling VTXOs back onchain using only locally held,
pre-signed proofs, even if the ASP is dead or hostile. The official Arkade PWA
doesn't implement this at all; even the SDK's own `Unroll.Session` needs a live
indexer as shipped. See [DESIGN.md](DESIGN.md) for the surrounding
architecture; this file is the *why* for the exit feature specifically.

SDK behavior below was verified against `@arkade-os/sdk` dist source and the
`../ts-sdk` clone (function names cited; line numbers are version-specific, so
they're orientation, not contract). The implementation planning record —
subtask breakdown, spike results, measurements — is [EXIT_PLAN.md](EXIT_PLAN.md).

## 0. What unilateral exit means

With Ark, **seed ≠ recovery.** The key does not carry the data needed to leave;
a VTXO's escape route is a chain of pre-signed transactions the ASP hands out on
request. Unilateral exit is: take that chain, broadcast it to the blockchain
(unrolling the tree back to a leaf), wait out a CSV timelock, then spend to a
plain address you alone control. The whole point is that it must work **with no
ASP and no Boltz** — otherwise "self-custodial" is a promise the infrastructure
can't keep in the one moment it matters.

Three facts shape everything:

1. **Every tree/ark transaction is zero-fee.** They can never enter a mempool
   alone; each must be broadcast in a 1P1C package with a CPFP child that pays
   the fee. So exit needs a fee source under the *user's* sole control, not the
   ASP's.
2. **The proofs are ASP data.** The SDK fetches them from the indexer at exit
   time. That's fine while the ASP lives and useless when it doesn't — so the
   bridge must mirror them locally, continuously, ahead of need.
3. **Chain depth is exit cost.** A VTXO that received many offchain payments
   without settling has a deep chain; unrolling it means one 1P1C package per
   hop. A mainnet measurement on the operator wallet: 53 unrefreshed hops →
   ~107 packages ≈ ~32,000 vB. Settling (refresh) resets the chain to a
   tree-leaf depth and with it the exit price.

## 1. Decisions

- **A separate `/exit` tab**, always reachable — including in degraded mode
  (§4). It's the emergency surface; it can't depend on the thing that's on fire.
- **Reuse `Unroll.Session`, don't reimplement it.** The session's constructor
  takes the chain directly and the only indexer method it calls per step is
  `getVirtualTxs` (`../ts-sdk .../wallet/unroll.ts` `next()`). A sqlite-backed
  stub that serves that one method from the vault makes the whole SDK unroll
  path run offline. Step derivation is recomputed from onchain state every call
  (the session skips whatever is already confirmed), so **restart-safety is
  free** — resume just re-runs the session.
- **Proofs are mirrored, not fetched on demand.** A background service keeps the
  vault current while the ASP is alive (§3). Exit reads only from the vault.
- **CPFP fuel and sweep destination are both the nsec-derived plain P2TR.**
  `OnchainWallet.create(identity)` derives a Taproot address from the same key
  the wallet uses (`../ts-sdk .../wallet/onchain.ts`). No separate key, no extra
  backup. The user funds this address with enough sats to pay exit fees.
- **Execution is strictly per-VTXO. There is no bulk "exit all" button.** Exit
  economics differ wildly per VTXO — a 660-sat VTXO is above dust yet worth less
  than the two or three onchain transactions its exit costs, while a deep-chain
  VTXO can be uneconomical at a high fee rate. The tab shows tx count, total
  vBytes, sats at the current fee rate, and % of value per row, with an explicit
  "exiting loses money" verdict, so the user judges each one. (Sweep *batches*
  multiple already-CSV-elapsed VTXOs into one transaction — that's fee sharing,
  a separate concern from the exit decision, which was already made per-VTXO.)
- **Degraded boot is a prerequisite** (§4). Without it the bridge can't even
  start with the ASP down, so the exit tab could never appear when needed.

## 2. Architecture

```
Normal (ASP alive):
  ProofSync ─ triggers: boot reconcile / notifyIncomingFunds /
              bridge-initiated send·settle / slow poll
            → getVtxoChain (paged) + getVirtualTxs (only missing txids)
            → Vault(sqlite): exit_proof_txs ⊕ exit_vtxos → GC
  Dashboard "Exit readiness" tile (N/M exit-ready · freshness · KB)

Emergency (ASP dead → degraded boot):
  ExitEngine ─ Vault chain → Unroll.Session(VaultIndexer,
               bumper = OnchainWallet(nsec P2TR), own esplora)
             → per-step 1P1C broadcast → CSV wait → local sweep → nsec P2TR
  /exit tab ─ per-vtxo ledger + stepper + controls, always reachable
```

Modules under `src/exit/`:

- `vault.ts` — the two-table store + readiness/GC/stats. Network-free.
- `proof_sync.ts` — one pure mirroring pass (diff → fetch → store → GC).
- `sync_service.ts` — schedules that pass (debounce, retry, poll) + SSE.
- `esplora.ts` — `pickEsplora`: first live endpoint from the priority list.
- `vault_indexer.ts` — `IndexerProvider` served from the vault; everything
  except `getVirtualTxs`/`getVtxoChain` refuses loudly.
- `csv.ts` — CSV-elapsed judgment + per-path countdown (replicated from the
  SDK's module-private `availableExitPath`).
- `estimate.ts` — offline exit cost from measured finalized vsizes.
- `engine.ts` — drives `Unroll.Session`, owns `exit_ops`, sweeps, funding.
- `ops.ts` — the coarse `exit_ops` intent records.
- `stepper.ts` — the per-vtxo visual step model (vault + esplora).

## 3. Proof vault (the offline mirror)

Two tables (migration v10):

- `exit_proof_txs(txid PK, type, psbt_base64, first_seen_at)` — the pre-signed
  PSBTs, one row per txid. VTXO histories form a DAG, so a txid PK **dedupes
  branches shared across VTXOs and within one VTXO's own history** for free
  (mainnet: 119 chain refs → 107 unique txs on one VTXO). Rows are immutable — a
  pre-signed PSBT for a txid never legitimately changes.
- `exit_vtxos((txid,vout) PK, value_sat, script, tap_tree, status, expires_at,
  chain_json, synced_at)` — the per-VTXO snapshot the Wallet-less sweep needs
  (value + tap_tree) plus the ordered chain verbatim as the indexer returned it
  (the `Unroll.Session` input).

The row shape is **our own minimal serialization**, not the SDK's `serializeVtxo`
(which isn't exported from the package root) — a side benefit is that the vault
is insulated from SDK serialization drift. Only the fields exit actually needs
are columns; the chain is opaque SDK JSON.

**Completeness is never trusted from a row's existence.** A VTXO row can
momentarily reference proofs not yet fetched (the indexer serves the fresh PSBTs
a few seconds after a settle). Readiness is always recomputed by joining a
chain's required txids against `exit_proof_txs` (`isVtxoExitReady`), so a
half-mirrored VTXO reads as not-ready rather than as a silently broken exit.

**ProofSync** (`proof_sync.ts` + `sync_service.ts`) keeps it current. One pass:
diff live VTXOs against the vault → fetch chains (paged) only for incomplete
ones → fetch only the PSBTs the vault lacks (paged, batched) → store atomically
per VTXO → GC rows the live set no longer references. Fetched PSBTs are keyed by
their **decoded txid, never response order** — a mislabeled proof would surface
as a broken exit at the worst possible time, so the label comes from the payload
itself. Ancestry is immutable, so a proof-complete VTXO costs zero network
traffic on later passes. The scheduler collapses trigger bursts into one pass,
escalates retry while a pass reports gaps (absorbing the post-settle
availability lag), and polls every ~10 min as the missed-event safety net.

**Exit readiness is a first-class dashboard citizen** because proof freshness
*is* exit possibility: if the ASP dies after the last sync, VTXOs received in
the gap can't leave. The tile shows N/M exit-ready, last-sync freshness, and
proof size, with gaps in red.

## 4. Degraded boot

`Wallet.create` awaits `arkProvider.getInfo()` at boot, so before this feature a
dead ASP meant the bridge couldn't start — the exact moment the exit tab is
needed. Now any `bootReady` failure lands in `mode:'degraded'` instead of
crashing: the web server stays up, `/` renders a status page built from
ASP-free materials only (local vault stats, the nsec-derived P2TR + QR), the
exit tab works, and ready-only routes bounce to the status page. A 60s loop
retries the full bring-up and promotes to ready in place; open tabs reload on a
`mode-change` SSE event.

**Whole-or-degraded, on purpose.** A partial-ready state (wallet up, Boltz down)
would fork `AppState` into per-subsystem availability flags for a rare, transient
condition the retry loop already heals — not worth the complexity. This also
covers a Boltz-only outage: a transient Boltz failure alone used to crash boot.

`bootReady` carries an **undo stack**: with a retry loop, a failure past
`initArkWallet` would otherwise leak a `VtxoManager` poll + SSE watcher set per
minute, so a partial bring-up is unwound before the throw. The exit engine is
created *outside* `bootReady`'s try (it needs only sqlite + the nsec + esplora),
so in-flight exits keep progressing even while the bring-up keeps failing.

## 5. The exit engine

`startExitEngine` (`engine.ts`) runs the SDK session over `VaultIndexer` with
CPFP fees from the nsec `OnchainWallet` (esplora from `pickEsplora`) — identical
in ready and degraded mode.

`exit_ops` (migration v11) are **coarse** intent records: `unrolling → waiting →
sweepable → swept`, plus retryable `failed`. Coarse because unroll position is
re-derived from chain state each run — a crash mid-exit needs no precise replay,
`resume()` just re-runs the session and the session skips what's already
onchain. Ops run **strictly one at a time**: shared history branches then
dedupe naturally (the second session sees the shared txs onchain/in-mempool and
skips/waits), and the single CPFP wallet never races itself for its UTXOs.

Flow per VTXO: the session broadcasts the chain root→leaf as 1P1C packages
(`op = unrolling`); once every chain tx is confirmed the CSV clock starts
(`waiting`); a 60s poll checks the tapTree's CSV path against the VTXO tx's
confirmation height via esplora and flips to `sweepable`; the sweep spends
through the exit path to the nsec P2TR (`swept`, sweep txid recorded).

**Sweep** (`sweep.ts`) is a local adaptation of the SDK's
`prepareUnrollTransaction`, which reads everything off a live `Wallet` that
doesn't exist in degraded mode. Every ingredient comes from elsewhere: inputs
from the vault row (tap_tree → exit leaf + nSequence, value → witnessUtxo),
confirmation and fee rate from esplora, signature from the nsec identity. Guards
before broadcast: CSV actually elapsed per input, fee < value, net output ≥ dust
(546). Batching multiple sweepable VTXOs into one transaction shares the output
overhead so a sub-dust VTXO that could never clear a solo sweep rides along.

**Estimator** (`estimate.ts`) prices the path offline: stored PSBTs are
finalized in memory with the exact session rules (TREE `tapKeySig` /
`finalize()`) so per-tx vsizes are measurements, not guesses, plus one CPFP
child per package and the CSV-path sweep sized from the actual leaf. It emits
packages / total vB / sats at the given rate / % of value / an `uneconomical`
verdict / `proofComplete`, feeding both the per-row cost column and the stepper.

## 6. The tab

- **`/exit` list** — one row per mirrored VTXO: value, expiry countdown (the
  hard deadline — red under 48h, "dead paper" once passed), measured exit cost,
  a verdict (exitable / proofs-incomplete / exiting-loses-money /
  swept-cooperative-recovery-only), and op state. A compact exit-fuel line.
- **`/exit/:txid/:vout` detail** — the stepper (§ requirement 10): broadcast
  steps root→leaf with state + vsize, the CSV `have/need` countdown, the sweep,
  each with redundant icon+text so state reads without color. Below it the
  action panel (Start/Retry/Sweep, gated on proof-completeness and op state,
  with the full cost beside the button and a short irreversibility confirm) and
  the funding panel (nsec P2TR + QR + onchain balance, low-fuel warning against
  the estimate).

Live updates are coarse: the engine's per-op events broadcast an `exit-op` SSE
carrying just the outpoint, and the client reloads if it's on the matching
detail or the list page — recomputing the stepper's per-tx onchain status on
every step would be too many esplora reads, and the detail page isn't kept open
constantly (same strategy as `mode-change`).

## 7. Scope-outs

- **Offchain receives the ASP didn't tell us about.** Detection rides
  `notifyIncomingFunds` (indexer subscription) + a reconcile poll, so anything
  the ASP surfaces gets mirrored. A VTXO someone hands you out-of-band that the
  ASP never reports won't be in the vault — accepted: a sale you make you'll
  know about instantly; a silent donation is the rare miss.
- **Swept VTXOs.** `isRecoverable` = state `swept` && unspent
  (`../ts-sdk .../wallet/index.ts`): once the ASP sweeps an expired batch the
  tree root is already spent, so complete proofs are dead paper and recovery is
  cooperative-only. This is the classic fate of stranded sub-dust. The vault
  still mirrors these VTXOs identically — the indexer serves the chain the same
  way, no special-casing — but the readiness metric and the tab flag
  status='swept' as "unilateral exit impossible, cooperative recovery only" so
  the numbers never overstate what can leave.
- **Sub-dust proofs.** Mirrored with no special treatment — the indexer serves
  the full pre-signed chain regardless of whether the resulting output could
  clear dust on broadcast. That economic/relay judgment lives entirely in the
  estimator + UI verdict, not in the proof layer. Consistency over cleverness.
- **Runtime demotion.** Degraded is a boot-time judgment. An ASP that dies
  *under* an already-ready bridge doesn't auto-demote (a transient network blip
  is hard to distinguish from a real death); the emergency procedure is "ASP
  down → restart the bridge," which then boots degraded.

## 8. Operating procedure (emergency)

1. If the bridge is running and the ASP is confirmed down, **restart it** — it
   boots into degraded mode and the exit tab is live.
2. Open `/exit`. For each VTXO worth exiting (check the cost/verdict), **fund the
   exit-fuel address** shown in the funding panel with enough sats to cover the
   estimated CPFP fees.
3. **Start** the exit per VTXO. The engine broadcasts the chain; leave it — it
   resumes across restarts. Watch the stepper progress.
4. When a VTXO reaches **sweepable** (CSV elapsed), **Sweep** it to your plain
   address. Batch several sweepable VTXOs together to share the fee.

## 9. Single point of failure

`POST {esplora}/txs/package` is load-bearing: zero-fee parents can't broadcast
alone, so with no package relay the feature is inert. Probed 2026-07-04 —
`mempool.space/api` and `mempool.arkade.sh/api` both relay bitcoind
`submitpackage`. The priority list is third-party-first (mempool.space) because
exit is the ASP-adversarial scenario, with the Ark-Labs-operated default as
fallback; a self-hosted mempool slots ahead of both via the `esploraUrls`
override. If both were ever to drop package support, the fallback is a local
bitcoind `submitpackage` RPC.

## 10. Testing

- Unit/integration: `bun test` (network-free; real PSBT fixtures drive the
  actual `Unroll.Session` and sweep signing without touching mainnet).
- Offline finalize regression after an SDK bump:
  `bun test/spike/offline_finalize.spike.ts --replay <dump>` re-verifies stored
  PSBTs still finalize under the new SDK's rules.
- Full onchain drill (the one broadcast path unit tests can't cover): the
  regtest environment — bitcoin core + arkd + esplora brought up locally, bridge
  attached via `data/config.json`, driven from the browser at localhost:4282.
  See EXIT_PLAN.md #15. Mainnet fixture dumps are never committed (they identify
  the wallet — EXIT_PLAN §6); committed fixtures are synthetic or regtest-sourced.
