# Unified wallet history (/history)

One chronological view over every rail the bridge executes or observes.
`transactions` only ever covered the four NWC LN flows; noffer/zap receives,
web sends (LN / Ark), onchain boarding deposits and offboards left no
wallet-level record at all. The SDK's `getTransactionHistory()` can't fill the
gap: it is a full recompute over all vtxos + a boarding-address scan with no
pagination (that's why the old ark-side /history tab was removed in
`a1a726a`), and neither arkd's indexer nor the ts-sdk exposes any wallet-level
paginated history API — the stale `IndexerTxHistoryRecord` proto message is a
remnant of a removed RPC. So the bridge keeps its own ledger.

## Decisions

- **New `history` table, not a widened `transactions`.** The
  `connection_id NOT NULL` FK and the `'incoming'|'outgoing'` type vocabulary
  of `transactions` are load-bearing: connection isolation for NIP-47 reads,
  and `list_transactions` passes `type` through unvalidated — new type values
  would leak into NWC clients. NWC rows are therefore dual-recorded (one
  NIP-47-shaped row, one ledger row); different consumers, cheap storage.
- **Mirrored kinds are a cache, never a second source of truth.**
  `nwc_ln` ← `transactions` (ref = `request_event_id`) and `offboard` ←
  `offboards` (ref = row id) get ONE insert at creation; every later state
  transition reaches history exclusively via `syncHistoryFromSources()` — two
  idempotent `UPDATE … FROM` statements run before each /history read. The
  alternative (pairing a history UPDATE with each of the ~6 transition sites
  across pay_invoice / boltz.ts / ln_receive.ts / offboards) invites drift for
  zero gain.
- **Self-owned kinds are written by their flow.** `web_ln` (pending → settle/
  fail around `sendLightning`; a bolt11 retry upserts the same row back to
  pending), `ark_send` (final-state only — the call is synchronous),
  `noffer` (inserted settled by the CLINK ack funnel, *before* the receipt
  publish; the funnel retries until the publish succeeds and the
  `(kind, ref)` UNIQUE absorbs the reruns), `onboard` (the watcher below).
  Web CLINK sends resolve to a bolt11 before /send/confirm, so they land as
  `web_ln` — expected, not a gap.
- **Interrupted web LN sends are terminalized at boot**
  (`sweepInterruptedWebSends`): they have no reconciler of their own and the
  money outcome lives on /swaps (SwapManager resume / atomic resume). The row
  says so instead of pretending to know.
- **Keyset pagination, strictly "Older »".** Cursor = `(created_at, id)`,
  `ORDER BY created_at DESC, id DESC`; the id tiebreak keeps same-second rows
  stable across pages and inserts can't shift older pages (no OFFSET). A
  single `created_at` index suffices — `id` aliases the rowid and SQLite
  index entries are `(key, rowid)`, so it already is the composite.
- **Amount semantics match `transactions`** (DESIGN.md §5): `amount_msat` is
  the nominal (BOLT11 nominal for LN, sats×1000 for ark/onchain),
  `fees_msat` our cost on top, wallet movement always derived. Sub-dust
  noffer receives are 1:1 (fee 0); ≥dust noffer fee = nominal −
  `response.onchainAmount` when the swap object carries it.

## Onboard watcher (src/boarding_history.ts)

Recording only — conversion is the SDK's job (VtxoManager auto-settles
confirmed boarding UTXOs; `settlementConfig` is on in wallet.ts) and it
exposes no event for it, so the watcher observes `wallet.getBoardingUtxos()`
on its own 60s interval (deliberately NOT a `reconcileReceives` pass: that
loop is poked by the boltz ws for sub-dust latency and must not wait on
esplora reads).

- New outpoint → `pending` history row + operator DM (`onboard` notify kind).
- Outpoint left the set → `settled`, but only after esplora confirms the
  spend (`/tx/:txid/outspend/:vout`) — a transiently short SDK list must not
  fake a settle. The spending txid (the settlement round) is stored as
  `txid2`.
- **Sweep suppression:** a boarding UTXO whose funding tx spends outpoints we
  have already seen as boarding UTXOs is the VtxoManager's expired-boarding
  rotation, not a deposit. Esplora down during classification → recorded as a
  deposit anyway (a rare visible extra row beats a silently missed deposit).
- **Watermark, no backfill:** every observed outpoint lands in
  `boarding_seen`; the first pass ever (sentinel row) baselines whatever
  already exists without minting history rows, so importing an old seed never
  resurrects years of deposits. There is no backfill of any kind on purpose —
  history starts when the feature starts.

## Known gaps (accepted)

- **Anything that doesn't pass through the bridge is invisible**: sends from
  the PWA on the same key, plain offchain receives to the Ark address.
  Classifying "new vtxo with no known context" as a plain receive needs a
  vtxo-mirror + exclusion bookkeeping (own change, auto-settle outputs,
  atomic claim legs) whose false-positive risk outweighs the gap today.
  Phase-2 candidate via `SubscribeForScripts` if real users ask.
- `transactions` rows that expire unpaid mirror into history as `expired`
  (rendered dimmed) — that is the honest record of an issued-but-unpaid
  invoice, not clutter worth special-casing away.
