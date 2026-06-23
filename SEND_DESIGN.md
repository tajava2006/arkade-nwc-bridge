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
- **Genuinely stuck case:** total spendable < onchain dust (~330) — no rail can
  form a valid output. CLAUDE.md 차별화 #2's "합계 < dust로 stuck". Only then
  block send + show a top-up hint.
- ⚠️ **`MAX_VTXOS_PER_SETTLEMENT = 50`.** `settle`'s full path takes the 50
  highest-value vtxos (`byValueDescending`) — with >50 vtxos the smallest
  sub-dust gets dropped first, so a single round can't always clean everything;
  may need repeated rounds (ties into 도매급 refresh, 差별화 #4).

## 6. Bridge integration notes

- A bridge-native send is a **wallet-side** action with **no `connection_id`** —
  it doesn't touch the per-connection NWC budget accounting. It shows up in the
  `/history` tab (wired to `wallet.getTransactionHistory()`), not in the
  connection-scoped NWC `transactions` table. Keep it that way; don't fabricate a
  connection row.
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
