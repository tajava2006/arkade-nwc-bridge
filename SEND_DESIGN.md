# SEND_DESIGN.md — bridge-native send

The bridge already *spends* through NWC `pay_invoice`, but only on behalf of a
connected Nostr client. This is the design for a **bridge-native send**: the
operator moves their own funds straight from the web UI, no NWC client in the
loop. See [DESIGN.md](DESIGN.md) for the surrounding architecture; this file is
the *why* for the send feature specifically.

All SDK behavior below was verified against `@arkade-os/sdk` /
`@arkade-os/boltz-swap` dist source (function names cited; line numbers are
version-specific so they're given as orientation, not contract). Fee policy
cross-refs the ASP-side `FEE_MODEL.md`.

## 1. Decisions

- **Separate `/send` tab**, not a dashboard tile. Dashboard is a read-only
  status surface; send is a money-moving action that needs a destination input,
  detected-route display, fee/amount preview, confirm, and an async result
  state (LN can take minutes). Add `'send'` to the `Nav` union in
  [`layout.ts`](src/web/views/layout.ts) and one route.
- **Loopback-only, single operator.** This is an operator tool, not the consumer
  payment app. Keep it functional, not polished — the polished versions of these
  flows belong in the separate payment app (差별화 자리 #1/#3). Don't over-invest
  in bridge UI.
- **No per-call `swapProvider`.** `ArkadeSwaps` is already bound to the
  operator's own Boltz at construction ([`boltz.ts`](src/boltz.ts) →
  `BoltzSwapProvider({ apiUrl: cfg.boltzApiUrl })`). Reuse the existing `swaps`
  object and the LN path automatically routes to our own Boltz.
- **Sibling Refresh action** (consolidate-all) lives next to send — see §8. It's
  the only way to mobilize sub-dust / swept VTXOs back into offchain-spendable
  funds without going onchain.
- **All UI copy is English** (warnings, labels, errors included).
- **Two-step review → confirm.** `POST /send` parses + classifies + computes the
  full breakdown and renders a confirm page; `POST /send/confirm` is the only
  route that moves funds. No funds move on the review POST. This gives the LN
  amount preview and the onchain "you'll send N, fee F, total out = N+F, ok?"
  confirmation. The confirm re-classifies the destination (doesn't trust the
  round-trip).

## 2. Destination → rail routing

Classify the pasted destination, then dispatch:

| Destination | Rail | SDK call | Latency / fee |
|---|---|---|---|
| bolt11 invoice | Lightning | `swaps.sendLightningPayment({ invoice })` (same as `pay_invoice`) | seconds–minutes, Boltz `swapInFee`, auto-refund on fail |
| Ark address (`isValidArkAddress`) | offchain | `wallet.sendBitcoin({ address, amount })` (`send` is the successor) | instant, **free** (offchain-in/out fee = 0) |
| onchain address | **collaborative offboard** | `new Ramps(wallet).offboard(addr, feeInfo, amount?)` | one settlement round, arkd `onchain-output` intent fee |

Classification order: try `decodeInvoice` (bolt11) → `isValidArkAddress` → else
treat as onchain. `feeInfo` for offboard = `arkProvider.getInfo().fees`.

## 3. Onchain = offboard only, never Boltz chain swap

There are two ARK→onchain routes. We deliberately use **only** offboarding.

- **Offboard (collaborative exit)** = `wallet.settle({ inputs, outputs:[{onchain
  addr, amount}, change] })` — **1 onchain tx** (the round's commitment tx; the
  destination is one of its outputs). No Boltz spread.
- **Boltz chain swap (ARK→BTC)** = HTLC pattern: Ark-side VTXO→lockup is
  *offchain*, but the BTC side needs **2 onchain txs** (Boltz HTLC lockup + user
  claim — see `arkToBtc` / `waitAndClaimBtc` / `claimBtc` docstrings) **plus** a
  Boltz percentage fee. Structurally more expensive on both axes.

The Arkade PWA defaults to chain swap (with offboard as the out-of-limits
fallback — `Form.tsx` gates on `validArkToBtc`), because it's an **ASP-agnostic**
generic wallet pointed at public `boltz.exchange`: it can't assume the ASP wants
to front offboard liquidity on demand, so it routes through a known liquidity
provider.

**That rationale collapses for us:** operator = sole user, and Boltz is *our own*
instance / capital. Chain swap would just pay miners for 2 txs + a Boltz spread
to move funds between our own pools. We're also **emptying Boltz's onchain wallet
on purpose** (Boltz used for ARK↔LN only, general swaps disabled) and keeping
arkd-wallet's onchain reserve topped up. So offboard is strictly better:
1 onchain tx, no spread, funds come from the pool we actually keep funded.

**Cost: an offboard needs a settlement round and arkd-wallet onchain liquidity at
that moment.** `settle()` blocks until the round completes. Acceptable for an
operator. Aligns with 차별화 자리 #3 (cooperative offboard UI).

## 4. Fee / sweep model per rail

Goal: let the operator drain to zero ("send max") cleanly — the thing most BTC
wallets get wrong.

- **Ark offchain (free):** max = full spendable VTXO sum, change 0. Cleanest sweep.
- **Onchain offboard:** user pays only the arkd `onchain-output` intent fee
  (shape-based, preset). Settle arithmetic: `Σinputs = Σoutputs + intentFee`, so
  full-drain onchain output = `Σvtxos − intentFee`. **The actual commitment-tx
  miner fee is paid by the ASP** (our cost), regardless of the preset fee —
  `FEE_MODEL.md` confirms. `Ramps.offboard(addr, feeInfo)` with **`amount`
  omitted** sweeps the total automatically.
  - ⚠️ Currently arkd intent fees are all **0** (the `ARKD_*_FEE` env was a
    no-op; never set via admin API). So today: onchain-output fee = 0, max =
    full sum, ASP eats 100% of miner fee. Fine for solo; set real values via
    `arkd fees intent --onchain-output` before real users.
  - ⚠️ **CEL fee programs must return `double`.** The `Estimator` rejects an
    int-literal program (`"1000"` → "expected return type double, got int").
    Write `"1000.0"` for a flat fee, or an inherently-double expr like
    `"amount * 0.001"`. (FEE_MODEL.md's `"10"` example is wrong on this point.)
  - **UI amount = what the recipient receives** (net), not the gross. The fee is
    added on top: total leaving the wallet = `amount + fee`, and we pass
    `gross = amount + fee` to `Ramps.offboard` so the destination gets exactly
    the entered amount. (offboard's own param is gross — recipient = gross − fee.
    Exact for a flat fee; a tiny approximation under a proportional fee, which
    the confirm step's numbers reflect. MAX still omits the amount for a true
    drain, and the auto-filled MAX value is already the recipient net = total −
    fee.)
- **Lightning — exact drain is structurally impossible.** The invoice fixes the
  recipient's receive amount, and a swap fee must be paid from *somewhere*. You
  can't pay an external 8000-sat invoice with an 8000-sat balance.
  `sendLightningPayment` cost = invoice + Boltz fee, deterministic (routing fee
  is Boltz's, covered by its margin), but never zero. Drain-to-zero over LN only
  works if *you* control the invoice amount (self-directed), not for arbitrary
  external invoices. **Don't try to solve this.**

### MAX / "empty wallet" button rules

MAX is **rail-aware** — the spendable max differs per rail (see §7):

- **Ark send MAX** = offchain-spendable sum only (excludes sub-dust + swept;
  those can't be offchain inputs). Disable MAX when sub-dust/swept exist? No —
  just compute MAX off the offchain-spendable bucket; the sub-dust simply isn't
  included. (Disable the *button* only when offchain-spendable = 0.)
- **Onchain offboard MAX** = **all VTXOs incl. sub-dust + swept** − the
  `onchain-output` intent fee. `Ramps.offboard(addr, feeInfo)` with `amount`
  omitted sweeps everything (`getVtxos({ withRecoverable: true })`). So offboard
  MAX > ark-send MAX whenever sub-dust/swept exist. Compute and show the fee via
  `estimator.evalOnchainOutput({ amount, script })` (the same call offboard makes
  internally) — it's a CEL program, could be flat or proportional, so never
  hardcode a "fixed" number. Disable only when `total − fee < dust` (output would
  be sub-dust → invalid).
- **LN** is **amount-specified only** (paste invoice; no MAX button at all).
- To fully empty a wallet that has LN residual: send LN, then drain the
  remainder via Ark send or offboard.

## 5. Sub-dust truth — RAIL-DEPENDENT (verified)

`isSubdust(v) = v.value < dust`; `isRecoverable(v) = state==="swept" && spendable`
— **distinct** predicates. The decisive fact: **whether a sub-dust VTXO can be an
INPUT depends on the rail.**

**OUTPUT vs INPUT — the key framing:**
- Sending a tiny *amount* (sub-dust OUTPUT) works on offchain send — the output
  gets `subdustPkScript` (`sendBitcoin`/`validateRecipients`).
- Spending a sub-dust VTXO you *received* (sub-dust INPUT) does **not** work
  offchain. (Empirically: official wallet sends 10 sats fine, but the recipient
  cannot send those 10 sats onward.)

**Why:** a sub-dust output can't be unilaterally exited onchain (the onchain
output would be dust → invalid), so the protocol parks it until a settlement
round refreshes/consolidates it.

| Rail | sub-dust as INPUT | mechanism |
|---|---|---|
| pure offchain ark send (`send`/`sendBitcoin` auto-select) | ❌ no | ServiceWorker `handleGetVtxos` excludes sub-dust when `withRecoverable:false`; plus `_sendImpl` selection floor `btcAmountToSelect += max(amount, dust)` → a lone sub-dust can't reach the floor → "Insufficient funds" |
| settle / offboard / refresh (a round) | ✅ yes | `getVtxos({ withRecoverable: true })` + forfeit loop **skips forfeit** for `isRecoverable \|\| isSubdust` inputs (absorbed, no onchain forfeit needed) |

⚠️ The bridge uses the **plain `Wallet`** (not ServiceWorkerWallet — see
[`wallet.ts`](src/wallet.ts)). Plain `Wallet.getVtxos({withRecoverable:false})`
filters only `isRecoverable || isExpired`, NOT `isSubdust` — but the
`max(amount, dust)` selection floor still blocks a lone sub-dust, and spending a
sub-dust input offchain is unsupported / server-contaminating. **Treat sub-dust
as offchain-unspendable on the bridge too.**

**Design implications:**
- **Only offboard (a round) cleans sub-dust.** Pure offchain ark send cannot
  mobilize it. So "empty wallet incl. sub-dust" must route through offboard (or a
  self-settle/refresh), never ark-send.
- Offboard MAX (full drain): `Ramps.offboard(addr, feeInfo)` with `amount`
  omitted pulls `withRecoverable:true` and sweeps sub-dust into the single
  onchain output. **DustChangeError can't fire** (it's only for *partial*
  offboard change < dust: `if (change > 0n && change < dustAmount)`). So do NOT
  disable MAX when sub-dust exists — full-drain offboard is the cleanup path.
- **Partial offboard has a blocked top-dust window.** Round change is a freshly
  minted vtxo-tree leaf and arkd rejects leaves < dust (`AMOUNT_TOO_LOW`), and
  `Ramps.offboard` spends ALL vtxos (no coin selection) — so any recipient
  amount whose gross lands in `(roundTotal − dust, roundTotal)` cannot settle,
  regardless of vtxo composition. Anything below that window is fine (change
  leaf ≥ dust back to our own ark address). `offboardDustChange` (send.ts)
  pre-checks this at review AND confirm with a "send ≤ X or use Max" message;
  the background catch maps a raced `DustChangeError` to the same explanation.
  Burning the sub-dust remainder as extra intent fee would technically pass
  (arkd only enforces `fees ≥ minFees`) but is rejected on policy: operator =
  fee recipient, so it reads as skimming the user in a published product.
- **Genuinely stuck case:** total spendable < onchain dust (~330) — no rail can
  form a valid output. CLAUDE.md 차별화 #2's "합계 < dust로 stuck". Only then
  block send + show a top-up hint.
- ⚠️ **`MAX_VTXOS_PER_SETTLEMENT = 50`.** `settle`'s full path takes the 50
  highest-value vtxos (`byValueDescending`) — with >50 vtxos the smallest
  sub-dust gets dropped first, so a single round can't always clean everything;
  may need repeated rounds (ties into 도매급 refresh, 差별화 #4).

## 6. Bridge integration notes

- A bridge-native send is a **wallet-side** action with **no `connection_id`** —
  it doesn't touch the per-connection NWC budget accounting and never lands in
  the connection-scoped NWC `transactions` table. Keep it that way; don't
  fabricate a connection row. (There is no ark-side web history view anymore —
  the old `/history` tab was removed because `wallet.getTransactionHistory()`
  is a full recompute per call with no pagination; offboards get their own
  tracked list on `/send`, and LN sends show a one-shot result page.)
- Mainnet, alpha SDKs: confirm-before-send, surface the detected rail + fee, and
  treat offboard/LN as long-running (reuse the SSE pattern for result state).

## 7. Send-screen VTXO breakdown + balance (rail-aware)

Show every VTXO (a list/table is enough — a fancy graphic is optional polish,
don't over-invest), grouped into three buckets, with per-VTXO state and
time-to-expiry. Classify **per VTXO** using the exported predicates
(`isSpendable`, `isSubdust`, `isRecoverable`, `isExpired`, `isVtxoExpiringSoon`)
— do **not** derive availability from `WalletBalance`.

| Bucket | Predicate | Usable on |
|---|---|---|
| **Offchain-spendable** | spendable, ≥ dust, not swept, not expired | Ark send · LN · offboard |
| **Recoverable (round-only)** | sub-dust (`isSubdust`) **or** swept (`isRecoverable`) | **offboard / refresh only** — NOT ark-send/LN |
| **Boarding** | onchain deposit awaiting onboard | settle/onboard |

Footer totals: **offchain-spendable / recoverable-via-round / total** — NOT
"available / unavailable". Sub-dust and swept are *recoverable*, not dead money;
labeling them "unavailable" wrongly implies loss (offboard or refresh extracts
them). Flag `isVtxoExpiringSoon` VTXOs with a "renew soon" hint + countdown.

⚠️ **Do not compute the spendable total from `WalletBalance.available`.** The
`getBalance` impl buckets `recoverable` as `state==="swept"` **only** — its
docstring claims "subdust or swept" but the code ignores sub-dust. So a *settled*
sub-dust VTXO lands in `available` (`settled + preconfirmed`), making
`available` **overstate** true offchain-spendable funds. Per-VTXO classification
with `isSubdust` is the only correct source.

## 8. Refresh (consolidate-all) — sibling action, not a send

A manual **Refresh** button that folds **everything** into one fresh VTXO. This
is the only path that turns sub-dust / swept funds back into offchain-spendable
money without going onchain.

**Automatic trigger (2026-07-25):** the same consolidate-all is also the
*automatic* renewal path — `src/auto_refresh.ts` polls every 10 min and runs
the no-args `wallet.settle()` once any dust+ spendable VTXO is within **3d**
of expiry (sub-dust/swept can't trigger on their own: post-anchor-rule arkd
defers rounds anchored only by them). Rationale = the same win-win as the
button: one wholesale round instead of several partial renewals. The 3d
window is pinned by its neighbors: = arkd's expiry gap (larger just spams
deferred intents) and ≥ the atomic sub-dust send gate 72h10m (closes the
send dead zone to poll granularity, per the operator workspace's coupling
analysis). The SDK's `settlementConfig` renewal underneath stays a **fixed
1h backstop**, deliberately NOT scaled with the window — the SDK's renewal
guard is a 30s cooldown, so a backstop ≥ the tree expiry would loop a round
per minute (the pre-reset 1d-expiry seed is exactly such a config). Guards
in the wiring: 30-min failure backoff, and a 12h quiet period after each
success (rebirth-loop bound if expiry ≤ window; also spaces >50-VTXO
multi-batch folds).

- **Call: `wallet.settle()` with no params.** Per the ASP operator workspace's
  `SETTLEMENT_TRIGGERS.md` (trigger #1 — not in this repo), the no-param
  path sweeps **all** non-expired boarding inputs + **all** VTXOs
  (`getVtxos({ withRecoverable: true })`, uneconomical inputs filtered) into a
  single output back to the wallet's own address. One fresh VTXO, expiry clock
  reset.
- **Always consolidate-all. No GUI choice, no reserve, no threshold.** Regardless
  of how much expiry each VTXO has left. Rationale = the wholesale-refresh
  win-win (差별화 #4): onchain fee doesn't scale with VTXO count (ARK core
  property), so folding everything every time defragments for free. (The app's
  *automatic* #4 keeps a spending reserve so payments work mid-round; this is a
  *manual* operator button, so no reserve — the operator chose to do it now.)
- **Includes boarding inputs too** (no-param settle onboards confirmed boarding
  UTXOs). Consistent with "sweep everything"; just be aware Refresh also onboards
  pending onchain deposits.
- ⚠️ **`MAX_VTXOS_PER_SETTLEMENT = 50`** caps one round at the 50
  highest-value VTXOs (`byValueDescending`) — smallest sub-dust dropped first.
  With >50 VTXOs, one Refresh can't consolidate everything; warn (English):
  *"You have N VTXOs; only the 50 largest are consolidated per round. Run Refresh
  again to fold the rest."*
- **Depends on `offchain-input` fee = 0** (confirmed policy). If it were > 0, a
  sub-dust VTXO whose value < its per-input fee gets skipped (`inputFee.satoshis
  >= vtxo.value`) and stays stuck — i.e. nonzero offchain-input fee would break
  sub-dust recovery.
- Stuck case unchanged: if total recoverable < dust, no round can form a valid
  output → genuinely stuck (差별화 #2 top-up territory).

## 8b. Coin policy (2026-08-22) — one wear pocket, and never merge offchain

> Code: `src/coin_select.ts` (pure policy), `src/exit/cost_oracle.ts` (pricing),
> `src/wallet_spend.ts` (the funnel + the split). Tests:
> `test/unit/coin_select.test.ts`, `wallet_spend.test.ts`, `exit_cost_oracle.test.ts`.

§8 folds everything into ONE VTXO, which is right *inside a round* and wrong the
rest of the time: with a single coin, every small send chains the entire balance,
and the whole balance's unilateral-exit cost climbs with it. Measured on mainnet
(`src/exit/estimate.ts`): **a 53-hop chain is ~32,000 vB of packages.**

### The two facts the policy is built on

1. **Offchain merging is additive and permanent.** A vtxo's exit chain is every
   Arkade tx from its last batch-leaf ancestor down to it, and arkd's chain is a
   DAG — so an offchain tx's change output inherits the exit chains of **all**
   its inputs, unioned. Spend a 53-hop coin together with a pristine one and the
   pristine value is 53 hops deep too, forever.
2. **A settlement round resets it to zero**, regardless of how deep the inputs
   were: the outputs are fresh tree leaves.

⟹ **Merge only inside a round.** Offchain, prefer to spend exactly one coin.

### Which coin — the objective

Value the wallet at what unilateral exit would actually recover:
`P = Σ max(0, vᵢ − cᵢ)` (v = value, c = exit cost, n := v − c). Spending A from a
single coin i destroys `ΔP = A+h` when `n_i ≥ A+h`, `n_i` when `0 < n_i < A+h`,
and **0** when `n_i ≤ 0` — so ascending **n** minimizes it.

Not ascending *cost* (that eats a huge dirty coin whose value is still mostly
recoverable) and not ascending *value* (that eats a small pristine coin whose
value is fully recoverable). And merging a written-off coin into a solvent one
destroys exactly `|n| = c − v` extra, because the pool is forced to pay that
coin's exit cost to reach its value — hence written-off coins are left OUT of a
forced merge.

### The rule

1. a single coin that covers the target → the one with the lowest `n = v − c`
   (ties → the smaller coin, so wear keeps landing in the same pocket)
2. else merge across **solvent** coins only (`n > 0`), cheapest chain first
3. else, and only then, merge everything

Plus a sub-dust guard: a total landing strictly inside `(target, target+dust)` is
not "covered" — that change would be minted as a stranded sub-dust vtxo.

**Why explicit selection at all:** the SDK's own selector sorts (batch expiry
asc, **value desc**), i.e. it reaches for the biggest coin first. Under a
hot/cold wallet that means every send dirties the cold coin — exactly backwards.
`Wallet.sendBitcoin({ selectedVtxos })` is the only explicit-selection surface
the SDK exposes (`send(...recipients)` always runs its own selector); it is
`@deprecated` on the method name only — the branch is first-class (tx lock,
dust-aware change scripts, same `_submitOffchainSpend`).

⚠️ **Safety valve:** `sendBitcoin({selectedVtxos})` skips the
`pendingRecoveryOutpoints()` filter that `send()` applies. That set is empty
unless the ASP advertises **deprecated signers**, so when it does,
`sendSelected` hands coin choice back to the SDK. Correctness beats coin policy.

### Pricing (`cost_oracle.ts`)

`estimateExit` against the **offline proof vault** — no network, works in
degraded mode — at a fixed `EXIT_REF_RATE_SAT_VB = 5`. Deliberately a constant,
not `exitEngine.feeRate()`: this is not a fee prediction, it is the policy knob
"at what assumed exit cost is a coin written off". Unknown ⇒ **0** ("assume
pristine"), which is the safe direction — the policy then avoids spending a coin
it can't price, and a single-coin spend contaminates nothing anyway.

### The hot pocket

After each consolidate-all (auto **and** the manual button), `splitHotPocket`
carves **one** pocket of `HOT_POCKET_SATS = 5,000` back out with a plain
self-send, leaving `[hot, cold]`.

- **What the number actually sets is the ASP-death write-off.** The pocket is
  what every small spend chains onto, so its exit cost passes its value quickly
  and it becomes economically abandoned — by design. Everything else keeps
  exiting at batch-leaf cost. 5,000 sats is not tuned and doesn't need to be; it
  only has to be long-lived, and a sub-dust send costs `a + fee`, so it absorbs
  thousands of 1-sat zaps before dropping under the ~661 sats an atomic funding
  needs.
- **No refill machinery, deliberately.** When the pocket is finally too small,
  the selector just spends the cold coin alone and its change becomes the new
  working coin. A worn pocket is still ≤ `HOT_POCKET_SATS`, so it never
  re-triggers a split.
- **Why a self-send and not two outputs on the settle itself** (which would leave
  both at batch-leaf depth instead of one hop): reproducing no-arg
  `wallet.settle()` means reimplementing its private internals — boarding-UTXO
  gathering, per-input fee filtering, `MAX_VTXOS_PER_SETTLEMENT`, the dust check
  — against SDK helpers that aren't exported (`byValueDescending`,
  `toOffchainInputFeeParams`), i.e. code that breaks silently on an SDK bump.
  **Losing boarding absorption on a refresh is far worse than one extra hop**,
  and that hop is a FIXED cost paid once per refresh cycle, not an accumulating
  one.
- Best-effort: a failed split leaves a perfectly good consolidated wallet, so it
  is logged and swallowed. Selection then degrades to "spend the one coin" —
  exactly the old behaviour.

### Concurrency: serialize, don't reserve

Two zaps fired at once (Amethyst zaps several people in one tap) used to race:
both selected coins, both submitted, one lost with `VTXO_ALREADY_SPENT`.

The SDK already solves this for its own spends and we simply weren't using it:

- `Wallet._withTxLock` is a FIFO promise chain — `send`, `sendBitcoin` and
  `settle` all pass through it, so they queue rather than collide. It *is* the
  queue; there was never a reason to build a second one.
- `_addPendingSpends` hides an in-flight spend's inputs from concurrent
  `getVtxos()` until it is persisted, which covers the window where the
  indexer still reports a just-spent coin as spendable.

The atomic sub-dust send bypassed **both**: it read coins straight off
`RestIndexerProvider` and submitted through its own `fundShared`. It now
selects from `wallet.getVtxos()` and funds via
`wallet.sendBitcoin({ address: <shared script as an Ark address>, amount: <the
selected total>, selectedVtxos })` — whole-input is just "amount equals the
total", which leaves no change and keeps the shared output at vout 0, the same
contract `fundShared` had. `fundShared` itself stays in the vendored core
because boltz still funds that way on the receive leg.

**Why not per-VTXO reservation.** It looks like more concurrency and is
actively wrong here: the hot-pocket policy makes concurrent zaps pick the SAME
coin by design, so reserving it would push the second zap onto **cold** — the
contamination §8b exists to prevent. Serialized, the second zap instead spends
the first one's change, which is still the hot coin. Wear stays concentrated.
The cost is that zaps queue behind each other; a sub-dust send is one offchain
tx plus boltz's LN pay, so that is the right trade.

Note this also closes a race the two-locks approach could not: an atomic send
and the auto-refresh `settle()` are now on the same lock, where a bridge-local
mutex would have left them on separate ones.

### Honest trade-off

In a world with no sends, splitting *costs* a little: N clean leaves are dearer
to exit than one (each needs its own branch). The win only appears once the hot
coin is dirty and the cold one isn't — which is after a handful of transactions,
not hundreds.

### Related fix

`estimateExit` counted a chain's **shared ancestors twice** — arkd's BFS
re-emits them per branch (`chain_order.ts` documents it; `stepper.ts` already
deduped). Diamonds are exactly what multi-input spends create, so the oracle
would have over-priced precisely the coins this policy reasons about. Fixed by
de-duping `wanted`.

## 9. CLINK noffer send (pay a noffer)

The receive side ships a CLINK noffer ([RECEIVE_DESIGN.md](RECEIVE_DESIGN.md));
this is the matching send side. Key framing: **a noffer is not a new payment
rail — it's a deferred bolt11 source.** Resolve it to an invoice, then fold into
the existing Lightning path. Spec: reference/CLINK/specs/clink-offers.md.

### Model: resolve-at-review, then fold into LN

- `/send` (review) classifies a `noffer1…` destination, does the kind-21001
  request/response round-trip to fetch a bolt11, and renders the confirm page
  with the *resolved invoice*. `/send/confirm` pays that bolt11 via the existing
  `sendLightningPayment` path — no new payment-layer code.
- **Stateless.** The resolve is a transient round-trip inside one HTTP request;
  unlike the receiver, no DB table. The payment is the existing LN result/history.

### Classification

- Add `noffer1` prefix → rail `'clink'` to `classifyDestination`, ahead of
  bolt11/ark/onchain (unambiguous prefix).

### Resolve round-trip (our own sender loop — no ClinkSDK dep)

Mirror of the receiver, requester direction (decoder already vendored as
`nofferDecode` in [`clink/nip19_offer.ts`](src/clink/nip19_offer.ts)):
1. `nofferDecode(noffer)` → `{ pubkey, relay, offer, priceType, price? }`.
2. Generate an **ephemeral key** per request (spec MAY; keeps operator payments
   unlinkable to a stable identity).
3. nip44-encrypt `{ offer, amount_sats? }` (ephemeral ↔ pubkey) → kind 21001
   `tags:[['p',pubkey],['clink_version','1']]` → publish to the noffer's single
   relay.
4. Subscribe on that relay for the response (kind 21001, `#p`=ephemeralPub,
   `#e`=requestId), **timeout ~15–20s**. One-shot, so `pool.subscribeMany`
   directly — not `openPersistentSub`.
5. Result: `{ bolt11 }` | `{ error, code, range?, latest? }` | timeout.

### priceType → amount UX

Spec: `amount_sats` is **required for spontaneous(2)/variable(1)**, optional
otherwise. Decode gives priceType + optional price (TLV 4):

| priceType | amount input | request | note |
|---|---|---|---|
| Fixed (0) | hidden/disabled | no `amount_sats` | returns the fixed invoice (no error); show TLV4 price if present, else "amount set by payee" |
| Variable (1) | required | `amount_sats` | service prices it; confirm shows the *returned* invoice amount |
| Spontaneous (2) | required | `amount_sats` | payer sets it (our own noffer is this) |

Confirm always shows the **bolt11's actual amount** (source of truth), not the
requested one — so a variable-priced quote is seen before paying.

### Response / error UX (the hard part)

- **Success** → confirm page (payee = noffer truncated, amount from invoice,
  Boltz swap fee, total) → confirm pays the bolt11.
- **code 1 Invalid Offer** → "offer no longer valid".
- **code 2 Temporary Failure** → "payee service temporarily unavailable, retry".
- **code 3 Expired/Moved** → if `latest` present, auto-retry once with the new
  noffer (spec SHOULD); else "offer expired".
- **code 4 Unsupported Feature** → "offer doesn't support this request".
- **code 5 Invalid Amount** → show the response `range{min,max}`.
- **relay unreachable / timeout** (single relay, no fallback) → explicit error:
  "couldn't reach the offer's relay — the code may be stale; ask the payee to
  regenerate." ← the main UX state to get right.

### amount/MAX, fire-and-forget

- **No MAX** — like LN, amount-specified; drain-to-zero is structurally
  impossible over a swap (§4).
- **Not fire-and-forget** — resolve is a synchronous await (+timeout) inside the
  review POST; payment is the existing LN async/SSE result. No new state machine.
  A dead relay stalls review until timeout (success is ~1–3s); acceptable for an
  operator tool, SSE progress is optional polish.

### Integration points

- New `clink/send.ts`: `requestNofferInvoice(pool, { noffer, amountSats? })`.
- `/send` review: on `'clink'`, resolve → on success promote to the LN confirm
  path carrying the bolt11 (hidden field); `/send/confirm` unchanged.
- ⚠️ resolve needs the shared `SimplePool`, which the web routes don't hold today
  (`offers`/`nostr` own it) — expose it on ready-mode AppState (one-line wiring).

### Non-goals (now)

- **Sending a zap** (embedding a 9734) — paired with the receive-side zap, which
  is blocked on the SDK descriptionHash gap (ts-sdk#576). Phase 2.
- `payer_data` / `expires_in_seconds` — optional fields, skipped in MVP.
