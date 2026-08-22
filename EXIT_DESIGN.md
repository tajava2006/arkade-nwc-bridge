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

Two tables:

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
per VTXO → evidence-gated GC over rows the live set dropped (below). Fetched
PSBTs are keyed by their **decoded txid, never response order** — a mislabeled
proof would surface as a broken exit at the worst possible time, so the label
comes from the payload itself. Ancestry is immutable, so a proof-complete VTXO
costs zero network traffic on later passes. The scheduler collapses trigger
bursts into one pass, escalates retry while a pass reports gaps (absorbing the
post-settle availability lag), and polls every ~10 min as the missed-event
safety net.

**Evidence-gated GC** (`evidence.ts`; the quarantine columns on `exit_vtxos`). GC used to trust the
server's live list outright — but a vault row's proofs ARE the exit
capability, so "the server said it's gone" deleting them means the server's
lie can destroy the very escape hatch built against it (the denial-of-funds
sibling of proof withholding, which the dashboard's proven/claimed check
covers). A dropped row is resolved strictly by verdict — and **nothing is
ever deleted silently**:

- **spent-verified** — the indexer names `spentBy` (set for offchain sends
  AND settlement forfeits — spike-confirmed against arkd, `test/spike/
  spend_evidence.spike.ts`) and serves that tx, whose input consuming our
  outpoint carries a schnorr signature that verifies against **our own
  x-only pubkey** (sighash recomputed from the PSBT itself; labelled
  `tapScriptSig` first, finalized witness stack as fallback). Keying on the
  signature rather than a local spend journal means a spend made from
  *another wallet holding the same nsec* verifies identically — no false
  alarms from the multi-client case.
- **absorbed** — settlement absorption, proven by **value conservation**
  (pass-level, resolved before the per-row verdicts): recoverable-class round
  inputs (sub-dust/swept) are consumed **without a forfeit** — arkd skips
  forfeits for them — so no tx signed by our key can ever exist and the
  per-row machinery would false-alarm on every refresh that folds sub-dust
  (observed mainnet 2026-07-27). Instead, the pass groups this pass's
  disappearances by the indexer's `settledBy` commitment and deletes a group
  only when the sats it took from us (amounts from OUR vault rows) exactly
  equal the sats that commitment created for us in the live set (the same
  `settledBy` ↔ `commitmentTxIds` correlation the SDK's history builder
  uses). Initiator-agnostic — bridge loop, SDK renew, manual button, or
  another wallet on the same nsec all land the round output in our live set.
  `settledBy` only *groups*: a lying server shifts rows between groups and
  breaks the equality, so failure always degrades to quarantine/expired,
  never to a wrong delete. Known conservative corners (row stays flagged for
  manual Forget): a boarding UTXO riding the same round, offboard rounds
  (output went onchain), the lump spent before the pass ran, or a mid-pass
  crash that already deleted forfeited siblings.
- **expired** — batch expiry passed by the local clock against the locally
  stored `expires_at`. Post-expiry the server sweeps without our signature
  legitimately, and the pre-signed chain is dead paper anyway. NOT deleted
  though: the lapse is the user's (no refresh before the deadline), but funds
  don't get to vanish without a word — the row is flagged with that story
  (its own dashboard line + /exit notice, distinct from the betrayal tone)
  and waits for a manual *forget*. Only fires when the server has also
  dropped the vtxo; a server that keeps returning an expired-but-recoverable
  vtxo (the refresh mercy) is a live-set member and GC never touches it.
  The stored deadline is **monotonic** (an outpoint's batch never changes,
  so its expiry never legitimately shrinks) — a server that shortens the
  reported expiry while the vtxo is live can neither fast-forward this
  verdict nor re-dress a betrayal drop as a user-fault lapse; the shortened
  value is simply not stored. A server that lies *from first sight* is the
  residual: that shows as an anomalously short countdown on /exit from day
  one rather than being cryptographically caught.
- **our own exit** — checked before the server is asked: an exit op in
  flight (unrolling/waiting/sweepable) keeps the row untouched — the vtxo
  leaves the live list the moment it's unrolled onchain, but the sweep still
  reads the vault (the old unconditional GC could strand a ready-mode exit
  here). A completed op (swept) is its own evidence and the row is removed
  without any server round-trip. NOTE: "leaves the live list" is enforced by
  our own wallet boundary, not the SDK — arkd keeps serving an
  unrolled-but-unspent vtxo as `isSpent=false` forever and the SDK's
  `withUnrolled: false` default never actually fires for it, so
  `installUnrolledVtxoFilter` (src/wallet.ts) drops `isUnrolled` rows from
  every `getVtxos` read (balance, /send, settle input selection, this sync's
  live set). Without it the exited vtxo haunts the balance permanently and
  one ghost input fails the consolidate-all settle wholesale
  (VTXO_ALREADY_UNROLLED — observed mainnet 2026-08-01). Ops-owned rows also
  leave the readiness math and the ASP claim symmetrically (vaultStats /
  sync_service) and surface as the dashboard's "exiting — sats in transit"
  line until the sweep lands.
- **unproven** — everything else: the row is **quarantined**
  (`quarantined_at`/`quarantine_reason`, first-flag time preserved), proofs
  retained, still exitable from the /exit tab until expiry. Quarantine
  self-heals in both directions — a re-listed VTXO is released, late-arriving
  evidence deletes. Network failure during the check is *indeterminate*, not
  unproven: the row stays un-flagged and the retry/poll re-asks, so our own
  connectivity can't cry wolf. The operator can `forget` a quarantined row
  from its detail page (e.g. a spend made in a way the bridge can't verify) —
  destructive, confirm-gated, quarantine-only.

Quarantined rows leave `vtxoCount`/`readyCount` (the server no longer claims
them, so counting them as ready would inflate proven-vs-claimed) and get their
own loud counter on the dashboard tile and the /exit tab.

**Atomic-swap rows** (`exit_vtxos.source = 'atomic'`) sit outside all of the
above: an in-flight atomic sub-dust send funds a shared vtxo at a script
address the wallet never lists, so the wallet-diff machinery can't mirror it
(the gap is *invisibility*, not quarantine) and would false-flag it every pass
if it could. `captureVtxo` mirrors it explicitly at funding time, the
disappearance GC skips `source='atomic'` rows (their eventual spend is by the
claimer's key — never verifiable as ours), and the swap lifecycle deletes the
row on terminal states. The uexit leaf is a standard CSV exit path, so the
engine unrolls/sweeps it with no special casing — economics permitting (V is
~a+dust; a solo sweep won't clear the dust floor, a batched ride-along will).
Rationale + the full operator Q&A: `ATOMIC_SUBDUST_PLAN.md` §8 (2026-07-16).

**Exit readiness is a first-class dashboard citizen** because proof freshness
*is* exit possibility: if the ASP dies after the last sync, VTXOs received in
the gap can't leave. The tile shows proven/ASP-claimed, last-sync freshness,
and proof size, with shortfalls, sync gaps and quarantines in red.

## 3b. Ancestry completeness (2026-08-22, F22)

A stored chain is only an exit proof if it **closes**: every non-commitment
entry's `spends` must resolve to another entry in the same array. If it names
an ancestor the array doesn't contain, that ancestor has no stored PSBT either
(proofs are fetched only for txs the chain lists), so the spend that needs it
can never be broadcast — the vtxo is unexitable.

**This was invisible and permanent.** `proofComplete` / `missingProofTxids` are
computed *relative to the stored chain*, so a hole hides itself from the very
check meant to catch it. And `syncProofs` treated "ancestry is immutable" as
"our copy of it must be right", short-circuiting on proof-completeness and
never re-asking. Two of three mainnet vtxos (60,863 sats) sat like that behind
a green Start button until the audit script found them.

What closes it:

- `chain_order.parentTxids` is now the single definition of an edge (strip a
  checkpoint's `:vout`, ignore blanks and self-references). The DAG layout and
  the completeness check read the same rule, so they cannot drift apart.
- `chain_order.danglingEntries` flags entries whose every named ancestor is
  absent. A commitment names nothing and is a root, not a dangle; an entry with
  one resolvable parent out of two is fine.
- **Self-healing**: `syncProofs` re-fetches any stored chain that dangles, and
  reuses only whole ones. A transient bad capture repairs itself on the next
  pass — no manual step, no repair tool.
- **Capture-time**: `captureVtxo` reports `dangling` and refuses to call such a
  capture complete, so a still-broken answer is logged rather than stored blind.
- **Honest gating**: `estimateExit` gained `ancestryComplete`, and the exit
  button gates on `proofComplete && ancestryComplete` with its own message
  ("missing an ancestor it needs"). `isVtxoExitReady` requires both too, so the
  /exit list's readiness and the dashboard tile stop over-reporting.

Diagnosis tooling, for when a chain looks wrong on screen:
`bun run check-exit-chains [db]` classifies each orphan (parent absent /
present-but-unlinked / spends empty) and prints the top level as rendered;
`bun run recheck-exit-chain [db] --url <arkd>` diffs the stored chain against
what the indexer serves now, which is what separates "stale capture" (re-fetch
repairs it) from "the indexer can't produce it" (upstream gap).

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

`exit_ops` rows are **coarse** intent records: `unrolling → waiting →
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

**Boost** (`boost.ts`) is the answer to a mempool spike mid-exit. The SDK has
no re-bump path — `Unroll.Session` returns WAIT forever while a package sits
in the mempool, and its `bumpP2A` prices the child once at broadcast time.
The pre-signed parent is immutable and zero-fee forever, so a bump always
means **replacing the CPFP child**: a new v3 child spending the same anchor
conflicts with the stuck one and rides in via RBF (v3 signals replaceability,
BIP431). We always resubmit `[same parent hex, new child]` as a package —
bitcoind dedupes an in-mempool parent, and the identical call recovers a
fully evicted package. Details that make it correct where re-calling the
SDK's `bumpP2A` would silently fail:

- **Fee floor**: RBF rule 4 wants old child fee + incremental relay × new
  size, regardless of what the estimate says. Fee = max(next-block rate ×
  whole package vB, that floor).
- **Confirmed-only fuel**: a v3 child gets exactly one unconfirmed parent
  (the tree tx), and spending the stuck child's change would be spending an
  output of the tx being replaced. The stuck child's own confirmed prevouts
  are first-choice fuel — esplora's UTXO endpoint hides them while the stuck
  child sits on them, but a replacement may reuse the replaced tx's inputs.
  They come from the raw `/tx/:txid` read (fee, weight, prevouts — no SDK
  method exists, `EsploraReader`), with the anchor spender found live via
  the parent's outspends (anyone can spend an anchor; a stored child txid
  could lie). mempool.arkade-style backends report the outspend as spent
  but **omit the spender txid** (regtest drill hit this live, and mainnet
  mempool.arkade.sh behaves the same) — the fallback scans the fuel
  address's unconfirmed txs for the one spending the anchor outpoint, which
  always finds OUR child because its change pays back to the fuel address.
- **No blind boosts**: a package sitting in the mempool always has a
  fee-paying child; if that child can't be read (esplora index lag), a
  rebuild has no floor — it comes out at the SAME fee, which is the same
  txid, which the node dedupes into a silent no-op (drill-observed). The
  boost refuses loudly instead; only an evicted package may rebuild
  floor-less.
- **Errors surface**: `bumpP2A` swallows broadcast failures in a
  `finally`-return; the boost path throws, because a silent no-op here costs
  the user blocks. And because `/txs/package` can wrap a submitpackage
  rejection inside an HTTP 200 (the SDK reads only the status), success is
  only reported after the replacement is **positively observed in the
  mempool** (`confirmInMempool`).
- The parent hex is **re-derived from the vault PSBT** with the session's own
  finalize rules (`finalizeProofTx`) — byte-identical to what was broadcast,
  no second copy to drift. The only persisted fact is the tip height at
  broadcast (`exit_broadcasts`), which feeds the "waiting N blocks"
  readout; a sweep RBF carries it forward to the replacement txid since the
  wait began at the first broadcast.
- **Concurrency is free**: the session's WAIT polls the parent txid, which a
  child replacement never changes — boost mid-session, and the session simply
  proceeds when the parent confirms.

The sweep gets the same treatment (`boostSweep`): it pays its own fee out of
the swept value, its CSV sequence already signals BIP125, so the boost
rebuilds the identical spend (same inputs, same destination) above the RBF
floor via `buildSweepTx(minFeeSat)` and updates every op the batched sweep
settled to the replacement txid.

## 6. The tab

- **`/exit` list** — one row per mirrored VTXO: value, expiry countdown (the
  hard deadline — red under 48h, "dead paper" once passed), measured exit cost,
  a verdict (exitable / proofs-incomplete / exiting-loses-money /
  swept-cooperative-recovery-only), and op state. A compact exit-fuel line.
- **`/exit/:txid/:vout` detail** — the chain drawn as the DAG it is
  (§ requirement 10): commitments (already onchain) across the top, spend
  edges downward, the vtxo's own tx at the bottom, then the CSV `have/need`
  countdown and the sweep as a short list. Node cards carry type + vsize +
  state with redundant icon+text so state reads without color; edges are an
  SVG overlay connected client-side after layout. Below it the action panel
  (Start/Retry/Sweep, gated on proof-completeness and op state, with the full
  cost beside the button and a short irreversibility confirm) and the funding
  panel (nsec P2TR + QR + onchain balance, low-fuel warning against the
  estimate).
- **Boost affordance** — a step (or the sweep) probed as in-mempool gets a fee
  context line: package rate vs the next-block estimate, plus "waiting N
  blocks" as reference material. **One activation rule**: the ⚡ Boost button
  exists exactly when the package rate sits below the next-block estimate —
  waiting time is never the trigger (a well-priced package that waits is
  luck, not something more sats can fix), and there is **no fee picker**: one
  preset (next block), the projected cost on the button, a short confirm.
  Boosting is always operator-initiated; nothing auto-spends fee money.

**Chain layout** (`chain_order.ts`, display only): arkd's getVtxoChain array
is a BFS from the vtxo upward with each branch's tree+commitment inlined
where the walk reached it, so a short branch's commitment lands mid-array.
The array is nevertheless a **valid broadcast order back-to-front** — within
a wave an ark tx precedes its own checkpoints and tree branches are emitted
leaf→root→commitment, across waves a checkpoint's parent is always enqueued
one wave deeper, and since outpoints have unique spenders (arkd's visited
set is per-outpoint), shared ancestors get re-emitted at each depth instead
of referenced backwards. `Unroll.Session` consumes exactly that shape (SDK
unroll.ts scans from the array's end), so **the engine hands Session the raw
chain untouched** — re-deriving the order would only add a failure mode.
What the BFS shape lacks is readability: `chainGraph` recovers the picture
from the `spends` DAG (checkpoints reference parents as "txid:vout"
outpoints; duplicate emissions collapse to one node) and layers it by
longest-path depth — commitments all on the top level, short branches
bridging down with long edges, deep branches filling every level.

The detail page renders **DB-only**, then fills in onchain state. A mainnet
chain is 100+ entries, and the first cut probed each one serially *before*
responding — long enough for Bun.serve's idleTimeout to kill the socket (the
page "crashed" with nothing in the logs). Now the page ships instantly with
every step defaulting to "not broadcast yet", and a ~30-line inline loop
probes `/exit/:txid/:vout/step/:stepTxid` one tx at a time in the engine's
broadcast order (the stored chain, back-to-front), swapping in each
server-rendered node. The first non-confirmed answer ends the scan: Session
broadcasts in exactly that order and waits out each confirmation, so the
sequence always reads `[confirmed…][≤1 mempool][absent…]` — an untouched
vtxo settles in one probe. Op states shortcut the rest:
waiting/sweepable/swept exist only after Session DONE, so their statuses are
final with zero probes ('waiting' probes the vtxo tx once, for the CSV
countdown). One esplora read per request, capped at 4s, keeps every probe far
under any socket timeout; a hung explorer degrades to "not broadcast yet"
plus a "status check unavailable" note.

Live updates are coarse: the engine's per-op events broadcast an `exit-op` SSE
carrying just the outpoint, and the client reloads if it's on the matching
detail or the list page — each reload re-arms the probe loop, which stops at
the frontier, so reloads stay cheap even mid-unroll (same strategy as
`mode-change`).

### DAG lanes

The chain renders as layers (`chain_order.chainGraph`): depth = longest path
from a root, so commitments share the top row. Within a row each node sits in
its own **lane** — roots left to right, everything else under the mean of its
parents' lanes, floored so a merge stays under its leftmost parent and the
trunk keeps lane 0. Rows are a CSS grid over `width` lanes rather than a
centred flex row; without that, every row re-centred independently and two
independent settlements read as one long zig-zagging line instead of two
parallel branches. Edges are only ever drawn between real `spends` pairs.

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
5. **Final send** (§11): once sweeps have landed, prove a destination address
   is yours (challenge signature) and send everything on the fuel address —
   sweep outputs plus leftover CPFP change — to it in one exact-fee tx. Or
   skip the bridge entirely: `bun run show-btc-key` and import the key.

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

## 11. Final send — the last mile (EXIT_PLAN #17)

Everything the exit produces lands on the nsec-derived fuel P2TR. That address
is already beyond the ASP's reach, but its key lives in the bridge — a user who
doesn't read taproot descriptors has no reason to *feel* exited. The last mile
moves the lot to an address whose key the user holds somewhere else entirely.
Two routes, both self-serve:

**Route 1 — take the key (`bun run show-btc-key`).** Prints the account key as
WIF plus a checksummed `tr(WIF)` descriptor (`src/lib/descriptor.ts` implements
Core's descriptor checksum so the output is paste-ready for
`importdescriptors`). The fuel address is `p2tr(xonly_pubkey)` with no script
tree — byte-identical to what Bitcoin Core/Sparrow derive from `tr(KEY)` — so
import + rescan finds the coins with no bridge involved. The printed warning
matters: this key IS the nostr identity.

**Route 2 — verified send (the /exit tab).** The bridge only sends to an
address the user has PROVEN control of: enter address → bridge issues a
challenge (embeds the address + a nonce, so a signature can't authorize any
other destination) → sign it with that address's wallet → `dest_verify.ts`
checks it. A typo'd or clipboard-hijacked address can't produce a verifying
signature, which is the entire point (verification is REQUIRED — the escape
hatch for wallets that can't message-sign is Route 1, never an unverified
send). Two schemes are accepted because no single one covers real wallets:

- **BIP-322 simple** — witness-stack signature over the virtual
  to_spend/to_sign pair; P2TR key-path (schnorr against the tweaked output
  key) and P2WPKH / P2SH-P2WPKH (BIP-143 ECDSA). Sighash DEFAULT/ALL only,
  key-path only. Pinned against the BIP's own P2WPKH vectors and the widely
  published P2TR vector.
- **Legacy Bitcoin Signed Message** — 65-byte recoverable ECDSA (Electrum,
  hardware wallets). Wallets disagree on the header-byte flag for segwit, so
  the flag's type hint is ignored: the signature passes if the recovered key
  derives the target address under any supported encoding (p2pkh compressed/
  uncompressed, p2wpkh, p2sh-p2wpkh, BIP-341-tweaked p2tr).

P2WSH and other script-hash-only targets are rejected up front — "the
destination must be a plain single-key address" is enforced by construction,
since proving control of a script hash from one signature is exactly what
these schemes can't do (p2sh passes only as p2sh-p2wpkh).

The send itself (`final_send.ts`) is the no-change sweep the operator wanted:
all *confirmed* fuel coins as key-path inputs, ONE output, fee computed from
the exact tx shape at the next-block rate, everything else to the verified
address. Unconfirmed fuel coins are excluded (their parent is our own RBF-able
sweep; a replacement would orphan the child). Inputs signal RBF and the boost
rebuilds from the stuck tx's own inputs — after broadcast the esplora utxo
endpoint hides the spent coins, so `getCoins` alone would find nothing — plus
whatever landed since, over the BIP-125 absolute-fee floor
(`exit_dest.send_txid` tracks the latest replacement; fee context is read live
like every other boost).

Before the button, the tab shows the vault tally (swept / total / unresolved)
as a last "are the unswept ones really the ones you chose to abandon?" gate —
informational, not enforced: whether an uneconomical vtxo is worth abandoning
was already a per-vtxo judgment (§1). A challenge-verified destination is also
offered as a direct sweep target on the per-vtxo page (skips the fuel hop —
one hop of fees less when CSV timing lets you sweep straight out).

State lives in the single-row `exit_dest` table: challenges
survive restarts because signing may happen on an air-gapped machine days
later; re-issuing replaces the row and voids the previous verification.
