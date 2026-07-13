# RECEIVE_DESIGN.md — bridge-native receive

The bridge already *receives* through NWC `make_invoice`, but only on behalf of a
connected Nostr client. This is the design for the bridge's own dashboard receive
surface: the operator's wallet taking funds in over every rail, no NWC client in
the loop. Counterpart to [SEND_DESIGN.md](SEND_DESIGN.md); see
[DESIGN.md](DESIGN.md) for the surrounding architecture.

All SDK/protocol behavior below was verified against `@arkade-os/sdk`,
`@arkade-os/boltz-swap`, and `boltz-backend` source (function names cited; line
numbers are version-specific, given as orientation, not contract). Fee policy
cross-refs `FEE_MODEL.md`.

## 1. Decisions

- **Receive is a read/display surface, not an action tab.** Unlike send, receive
  has no amount input and no `max` reasoning: you're handing out static handles
  and letting the payer decide the amount. No inbound-liquidity concern at the
  client either (that's the swap provider's problem, not the receiver's).
- **Three static handles on the dashboard**, all fixed + copy + QR:
  1. **Ark address** (`wallet.getAddress()`) — offchain L2 deposits. Nothing to
     build; already shown.
  2. **CLINK noffer** — the Lightning rail. Already built (§3).
  3. **Onchain boarding address** (`wallet.getBoardingAddress()`) — onchain →
     VTXO via native onboarding (§4–§5).
- **No per-invoice LN UI.** We deliberately do *not* add an "enter amount → show
  bolt11 QR" flow. The bet is that CLINK becomes the norm and most wallets gain
  "pay a noffer" support; the payer scans the static noffer and names the amount.
  Keeps the dashboard a set of static handles, not a form.
- **Onchain receive = native boarding, not Boltz chain swap** (§4). Consistency
  with the operator-funds story: boarded funds consolidate into arkd's pool.
- **No pure onchain (non-Ark) receive yet.** A plain onchain address that stays
  onchain only matters for unilateral exit; build it then. This wallet is a fast
  L2 wallet — every deposit should become a VTXO.
- **All UI copy is English.**

## 2. Source → rail

| Source | Rail | Mechanism | Onchain txs / cost |
|---|---|---|---|
| Lightning | CLINK noffer (reverse swap) | noffer → kind-21001 → `createLightningInvoice` → Ark | 0 onchain; Boltz reverse fee |
| Ark address | offchain | `wallet.getAddress()` | instant, free |
| onchain BTC | **native boarding** | `wallet.getBoardingAddress()` → fund → settlement round | 2 onchain (fund + round) |

## 3. Lightning receive = CLINK noffer (built)

Implemented in [`src/clink/`](src/clink/). The Boltz/CLINK SDK only ships the
*payer* half, so the receiver loop is ours.

- One static spontaneous-price offer (`offer id = "default"`), served under the
  **account key** (= the Ark wallet key; its pubkey is already inside the
  displayed Ark address, so exposing it as the offer pubkey leaks nothing new and
  needs no extra backup).
- noffer is minted from the operator's **current outbox relay [0]** at mint time
  and the encoded string is persisted (`clink_offer` table). On
  boot we decode the stored string and listen on the relay frozen into it — not
  the live outbox, which may have drifted. A noffer carries only one relay (spec
  TLV 1 is singular), so that single relay is the contact point; if it goes bad
  the operator regenerates by hand (dashboard shows its status). See
  [`offers.ts`](src/clink/offers.ts), [`nip19_offer.ts`](src/clink/nip19_offer.ts).
- Both responses (invoice and receipt) go to the relay the **request arrived
  on** — snapshotted into the handler for the invoice reply, persisted in
  `clink_offer_receipts` for the later receipt — never the
  "current" relay, so a regenerate/restart in between still reaches the payer.
- Flow: payer sends kind-21001 → we validate + `createLightningInvoice` (Boltz
  reverse swap → Ark) → reply bolt11 → on settlement publish the CLINK Payment
  Receipt (kind 21001 `{res:ok,preimage}`).

### Phase 2 — NIP-57 zaps (deferred, blocked upstream)

Real public zaps need the invoice to commit `description_hash = SHA256(zap
request)` so the kind-9735 receipt verifies (NIP-57 / nips/57.md). The chain:

- Boltz backend already accepts `descriptionHash` on `POST /v2/swap/reverse`.
- LND embeds a precomputed hash and prefers it over memo; the CLN hold plugin
  takes a precomputed hash too; CLN's core `invoice` cmd instead self-hashes a
  description (`deschashonly`). None verify hash == SHA256(description). BOLT11
  carries a description **or** a hash, never both.
- The only gap was `@arkade-os/boltz-swap`, which dropped `descriptionHash`.
  Fixed by upstream PR **arkade-os/ts-sdk#576** (adds the passthrough). Until it
  lands + releases, we do not advertise zap (offer id stays `default`, not
  `zap_`-prefixed) and do not emit a 9735 we can't make verifiable.
- When ready: validate the 9734 (NIP-57 Appendix D), pass `descriptionHash =
  sha256(exact zap-request string)` to `createLightningInvoice`, keep that exact
  string for the receipt, and on settlement publish kind 9735 (public, plaintext,
  to the relays in the 9734 `relays` tag — distinct from our nip44-encrypted
  CLINK receipt on the noffer relay).

### Sub-dust receive (< 330 sats) — non-atomic plain-invoice path

A Boltz reverse swap can't settle below P2TR dust (330 sats): the vHTLC lockup
vtxo is sub-dust, arkd marks it `VTXO_RECOVERABLE` and refuses to let the claim
spend it, so the swap strands. This is the receive-side mirror of the send-side
sub-dust problem (operator-workspace `SUBDUST_LN_PATCH.md`).
`createLightningInvoice` would reject or strand it.

So `handleOfferRequest` branches on `amount < 330` and instead calls an endpoint
we added to Boltz (operator workspace `patches/boltz-subdust-receive.patch`,
`POST /v2/subdust/receive {amount, address}`):

1. Boltz issues a **plain** invoice it collects (no hold).
2. We reply with that bolt11, same as the normal path.
3. On settlement Boltz sends a plain vtxo of the same amount to our wallet
   address — 1:1, **no swap fee** (the payer already paid routing; off-chain
   transfers are free).

This drops the reverse swap's atomicity. The trust sits on the **paying** side:
the external third party settles a real invoice with no on-chain guarantee or
refund, and only then does Boltz deliver the vtxo. The payer carries the
counterparty risk — this does **not** depend on the ASP and Boltz being one
operator (and the bridge is neither: it's the standalone user app). Below dust
there's no atomic alternative anyway, and the amounts are tiny — this is what
makes "21-sat zap receive" work where every other wallet refuses.

The received vtxo lands sub-dust (the `recoverable` balance bucket): not
spendable on its own until a settlement round folds it into a ≥dust vtxo (or a
cooperative exit), like any sub-dust receive. Expected, not a bug.

CLINK Payment Receipt (kind 21001): there's no Boltz swap to hook
`onReverseSettled`, so the sub-dust branch persists the ack info in
`clink_subdust_receipts` (keyed on the invoice payment hash) and
`reconcileClinkAcks` (boot + 30s, [`offers.ts`](src/clink/offers.ts)) asks boltz
`GET /v2/subdust/receive/status` whether it settled — if so, publishes
`{res:ok,preimage}` and deletes the row; a TTL drops never-paid rows. Same
reconciler also makes the ≥dust ack restart-safe (catches swaps the live
`onReverseSettled` missed while the bridge was down). Best-effort per spec.

**Status: verified end-to-end on mainnet (2026-06-27)** — noffer sub-dust zap → plain vtxo received.

## 4. Onchain onboarding: native boarding vs Boltz chain swap

Symmetric to send, two onchain→VTXO routes exist; we use **native boarding only**.

- **Native boarding** = fund `getBoardingAddress()`, then a settlement round
  pulls the boarding UTXO into the VTXO tree. **2 onchain txs**: the user's
  funding tx + the round commitment tx (the latter batches across participants).
- **Boltz chain swap (`btcToArk`)** = real and implemented in the SDK
  (`@arkade-os/boltz-swap` `arkade-swaps.ts` → `btcToArk` / `createChainSwap`
  `{to:"ARK",from:"BTC"}`). User funds a BTC lockup address (1 onchain), Boltz
  locks the Ark side offchain
  (VHTLC), user claims the VTXO offchain, **Boltz claims the BTC lockup onchain**
  (batched via `batchClaimInterval`, default `*/15 * * * *`). Also 2 onchain, plus
  a Boltz spread.

### Why native (and how this differs from offboard)

Onchain→VTXO is **inherently 2 onchain** on both routes — unlike VTXO→onchain,
where a cooperative offboard is 1 onchain and Boltz is 2 (so on *send* the native
route wins on tx-count; see [SEND_DESIGN.md §3](SEND_DESIGN.md)). On *receive*,
tx-count is a wash (2 vs 2) and batching is symmetric (round batches participants;
Boltz batches claims). Native still wins, for two other reasons:

1. **No Boltz spread** — native pays only miner fees + arkd onboarding intent fee
   (currently low/unset, like the onchain-output fee — see `FEE_MODEL.md`).
2. **Funds-flow** — native consolidates the onchain BTC into **arkd's pool**
   (good for round operations, unilateral-exit backing, and liquidity), whereas
   Boltz puts the BTC in Boltz's own wallet and drains Boltz's Ark liquidity to
   hand out the VTXO.

Note: a Boltz onboarding does *not* add a new liquidity requirement — Boltz needs
Ark liquidity anyway for LN→Ark reverse swaps (it hands the user a VTXO from that
same pool). So the deciding factor is spread + where the onchain funds land, not
liquidity setup.

UX consequence: an onchain deposit is **not instant** — it needs confirmations
and a settlement round before it shows as a VTXO. Surface it as "boarding /
pending round," not "received."

## 5. Why a fixed boarding address is safe (relative timelock)

The boarding output is a `DefaultVtxo.Script` (`@arkade-os/sdk`,
`src/script/default.ts`) — the same shape as a VTXO — with two tapleaves:

- **forfeit** = `Multisig(userPubKey, serverPubKey)` (2-of-2) → the cooperative
  path used to enter the settlement round.
- **exit** = `CSVMultisig(userPubKey, csvTimelock)` → user-alone reclaim after a
  timelock.

The exit timelock is **relative (CSV / `CHECKSEQUENCEVERIFY` / BIP-68
nSequence)**, sourced from the server's `ArkInfo.boardingExitDelay` (blocks if
`< 512`, else seconds), default 144 blocks ≈ 1 day. The boarding handler reuses
`DefaultVtxo.Script` with this delay (`contracts/handlers/boarding.ts`,
`wallet.ts` boarding tapscript).

Because the lock is *relative*, the address can be reused as a fixed handle:

- Each deposit's reclaim timer starts at **its own confirmation**. During that
  window only the forfeit (user+server) path is spendable, so the user can't
  RBF-grab a deposit before the round — the ASP only signs a legitimate round tx.
- An **absolute** lock (CLTV) would break this: once the fixed deadline passed,
  any new deposit to the reused address would be immediately user-spendable, so a
  fixed handle could be trolled. Relative locks have no such hole.
- If the ASP stops cooperating, funds are still safe (user reclaims after the
  delay). 2-of-2 means the ASP can never move the funds alone.

For our `SingleKey` wallet, `getBoardingAddress()` is deterministic → one fixed
address, ideal as a dashboard receive handle. (HD wallets can rotate boarding
addresses for privacy; we don't.)

Trade-off: address reuse leaks onchain privacy (deposits link together). Harmless
to fund safety (relative lock), and consistent with already reusing the Ark
address.

## 6. Ramp symmetry (send ↔ receive)

| | native (arkd) | Boltz chain swap | native edge |
|---|---|---|---|
| send: VTXO→onchain | offboard, **1 onchain**, arkd liquidity, needs round | `arkToBtc`, 2 onchain (BTC lockup + user claim) + spread | tx-count (1 vs 2) |
| receive: onchain→VTXO | boarding, 2 onchain (fund + round) | `btcToArk`, 2 onchain (user fund + Boltz claim) + spread | spread + funds land in arkd-wallet (tx-count is a wash) |

Boltz chain swaps are HTLC-based, ~4 txs total (2 onchain + 2 offchain Ark-side),
atomic via preimage. We keep Boltz for ARK↔LN only and leave its onchain wallet
unfunded, so chain swaps don't fire in practice anyway.
