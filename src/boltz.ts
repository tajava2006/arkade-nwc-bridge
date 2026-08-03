import {
  ArkadeSwaps,
  BoltzSwapProvider,
  decodeInvoice,
  isPendingReverseSwap,
  isPendingSubmarineSwap,
  isReverseFinalStatus,
  isReverseSuccessStatus,
  isSubmarineSuccessStatus,
  type BoltzReverseSwap,
  type BoltzSwap,
  type BoltzSwapStatus,
} from '@arkade-os/boltz-swap'
import { ArkAddress, RestIndexerProvider, type Wallet } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import type { Database } from 'bun:sqlite'
import { SqliteSwapRepository } from './boltz_repository'
import { SqliteAtomicSwapRepository, SwapDirection } from './atomic'
import type { Config } from './config'
import type { NotifyFn } from './nostr/notifier'

export interface BoltzContext {
  swaps: ArkadeSwaps
}

// M3: an inbound reverse swap "settled" is boltz's word, not evidence. The whole
// point of this wallet is not trusting the swap provider, so before we mark the
// recv row settled or hand a payer a 9735 receipt, confirm on the arkd indexer
// (not boltz) that THIS swap's VHTLC was spent into OUR wallet. The binding is
// exact — txids, never amounts: a value≈ match can be satisfied by a different
// same-amount swap's coin (the 2026-07-29 twin-invoice pair made that concrete,
// see the twin regression test). Poll a bounded window (the claim can land a
// beat after the settle event); on no confirm we defer so a later reconcile
// pass retries — self-healing, never a false success.
const REVERSE_LAND_POLLS = 4
const REVERSE_LAND_GAP_MS = 1000

/** The narrow indexer surface confirmReverseLanded needs (stubbable in tests). */
export type VtxoIndexer = Pick<RestIndexerProvider, 'getVtxos'>

export async function confirmReverseLanded(
  wallet: Wallet,
  indexer: VtxoIndexer,
  swap: BoltzReverseSwap,
): Promise<boolean> {
  // The VHTLC lockup address was committed into the swap at create time and is
  // unique to it (the payment hash is in the script) — decoding it gives the
  // exact script whose spend is this swap's landing, and nothing else's.
  const lockup = swap.response?.lockupAddress
  if (!lockup) {
    console.warn(
      `boltz: reverse swap ${swap.id} carries no lockupAddress — cannot verify the Ark landing, deferring`,
    )
    return false
  }
  let lockupScript: string
  let ourScript: string
  try {
    lockupScript = hex.encode(ArkAddress.decode(lockup).pkScript)
    ourScript = hex.encode(ArkAddress.decode(await wallet.getAddress()).pkScript)
  } catch (err) {
    console.warn(`boltz: reverse swap ${swap.id}: address decode failed — deferring:`, err)
    return false
  }

  for (let i = 0; i < REVERSE_LAND_POLLS; i++) {
    try {
      const { vtxos: lockupCoins } = await indexer.getVtxos({ scripts: [lockupScript] })
      const spent = lockupCoins.filter((v) => v.arkTxId || v.spentBy || v.settledBy)
      if (spent.length > 0) {
        // Our side comes from the indexer too, not wallet.getVtxos: by the time
        // a late reconcile runs, the claim output may itself have been spent or
        // refreshed away — the indexer still returns it for our script.
        const { vtxos: ourCoins } = await indexer.getVtxos({ scripts: [ourScript] })
        const landed = ourCoins.some((o) =>
          spent.some(
            (s) =>
              // offchain claim: the Arkade tx that spent the VHTLC is the tx
              // that created our coin (checkpoint id kept as a fallback match)
              (s.arkTxId !== undefined && s.arkTxId === o.txid) ||
              (s.spentBy !== undefined && s.spentBy === o.txid) ||
              // batch claim (recoverable VHTLC joined a round): our coin hangs
              // off the same commitment that absorbed the VHTLC
              (s.settledBy !== undefined &&
                (o.virtualStatus?.commitmentTxIds?.includes(s.settledBy) ?? false)),
          ),
        )
        if (landed) return true
      }
    } catch {
      // transient indexer read failure — retry the poll
    }
    await new Promise((r) => setTimeout(r, REVERSE_LAND_GAP_MS))
  }
  return false
}
/**
 * Classify a swap the SwapManager stopped monitoring. `onSwapCompleted` means
 * "monitoring completed", NOT "swap succeeded": finalizeMonitoredSwap emits it
 * on EVERY terminal status — invoice.expired, swap.expired, invoice.failedToPay
 * and transaction.refunded included — and the status-shaped failures never
 * reach onSwapFailed (that only fires on ws error payloads / action exceptions
 * / 404s). Success is a property of swap.status, so route on it; treating the
 * event itself as success recorded an unpaid invoice.expired receive as
 * settled — with a servable preimage — in transactions/history (2026-07-29).
 */
export async function onSwapTerminal(
  deps: {
    db: Database
    wallet: Wallet
    indexer: VtxoIndexer
    onReverseSettled?: (swap: BoltzReverseSwap) => void
    notify?: NotifyFn
  },
  swap: BoltzSwap,
): Promise<void> {
  if (isPendingReverseSwap(swap)) {
    if (!isReverseSuccessStatus(swap.status)) {
      // A failed reverse swap is an unpaid invoice expiring — routine noise,
      // recorded but deliberately not DMed. Must also not reach
      // onReverseSettled: that hook DMs recv-ln and publishes CLINK 9735
      // receipts, both of which assert the payer actually paid.
      syncSwapToDb(deps.db, swap, 'failed', `terminal status: ${swap.status}`)
      return
    }
    // M3: don't mark settled / don't ack the payer until the Ark vtxo has
    // actually landed (boltz's word isn't evidence). Deferred ones self-heal
    // via the periodic reconcile.
    const landed = await confirmReverseLanded(deps.wallet, deps.indexer, swap)
    if (!landed) {
      console.warn(
        `boltz: reverse swap ${swap.id} reported settled but no on-Ark vtxo ~${swap.request.invoiceAmount}s confirmed — not recording/acking (M3), retried by the reconcile pass`,
      )
      deps.notify?.(
        'recv-ln',
        () => `recv: reverse swap ${swap.id.slice(0, 8)} reported settled but the Ark vtxo wasn't confirmed yet — will retry`,
      )
      return
    }
    syncSwapToDb(deps.db, swap, 'settled')
    deps.onReverseSettled?.(swap)
    return
  }

  if (isPendingSubmarineSwap(swap)) {
    if (!isSubmarineSuccessStatus(swap.status)) {
      // Status-shaped submarine failure (invoice.failedToPay / swap.expired).
      // The live handler also marks its own row failed; this write is the
      // restart-resume backup and is pending-gated either way.
      syncSwapToDb(deps.db, swap, 'failed', `terminal status: ${swap.status}`)
      deps.notify?.('send-fail', () => {
        const nominal = decodeInvoice(swap.request.invoice).amountSats
        return `send: LN payment FAILED — ${nominal} sats (${swap.status}) [swap ${swap.id.slice(0, 8)}]`
      })
      return
    }
    syncSwapToDb(deps.db, swap, 'settled')
    deps.notify?.('send-ln', () => {
      const nominal = decodeInvoice(swap.request.invoice).amountSats
      const fee = swap.response.expectedAmount - nominal
      return `send: LN paid — ${nominal} sats (+${fee} fee) [swap ${swap.id.slice(0, 8)}]`
    })
  }
  // Chain swaps aren't surfaced through NWC — ignored (syncSwapToDb skips too).
}

export async function initBoltz(deps: {
  db: Database
  wallet: Wallet
  cfg: Config
  /**
   * Fired (in addition to the DB sync) when a reverse swap settles. Nostr-
   * neutral hook so clink/offers.ts can send its CLINK Payment Receipt
   * without coupling this module to the nostr stack.
   */
  onReverseSettled?: (swap: BoltzReverseSwap) => void
  /**
   * Operator DM sink (same nostr-neutral philosophy as onReverseSettled —
   * this module only sees a string sink). Submarine terminals are notified
   * from HERE, not the pay_invoice handler: the SDK fires once per swap
   * whether it settled live (NWC or web) or was resumed across a restart,
   * so a single source can't double-fire against the handler's own path.
   */
  notify?: NotifyFn
}): Promise<BoltzContext> {
  // M3's landing verification reads the arkd indexer directly — the same
  // server the wallet trusts, never boltz.
  const indexer = new RestIndexerProvider(deps.cfg.arkServerUrl)
  const swaps = await ArkadeSwaps.create({
    wallet: deps.wallet,
    swapProvider: new BoltzSwapProvider({
      apiUrl: deps.cfg.boltzApiUrl,
      network: deps.cfg.network,
    }),
    swapRepository: new SqliteSwapRepository(deps.db),
    swapManager: {
      autoStart: true,
      events: {
        onSwapCompleted: (swap) => onSwapTerminal({ ...deps, indexer }, swap),
        // Exception-shaped failures only (ws error payload, auto-action throw,
        // provider 404s) — status-shaped terminals (invoice.expired,
        // invoice.failedToPay, …) arrive via onSwapCompleted and are routed by
        // onSwapTerminal above.
        onSwapFailed: (swap, error) => {
          syncSwapToDb(deps.db, swap, 'failed', error.message)
          // Submarine only: reverse-side failures are receive noise,
          // deliberately not notified.
          if (isPendingSubmarineSwap(swap)) {
            deps.notify?.('send-fail', () => {
              const nominal = decodeInvoice(swap.request.invoice).amountSats
              return `send: LN payment FAILED — ${nominal} sats: ${error.message} [swap ${swap.id.slice(0, 8)}]`
            })
          }
        },
        // Observer-only: the SDK executes the refund either way; this just
        // makes it distinguishable from a plain failure for the operator.
        // claim* actions are ignored — settles are onSwapCompleted's story.
        onActionExecuted: (swap, action) => {
          if (action === 'refund' || action === 'refundArk') {
            deps.notify?.(
              'refund',
              () => `send: submarine swap refunded to wallet [swap ${swap.id.slice(0, 8)}]`,
            )
          }
        },
      },
    },
  })

  // ArkadeSwaps.create rehydrates pending swaps from the repository and the
  // SwapManager resume loop only re-monitors *non-final* swaps. Anything
  // that completed before the listener existed (or while the bridge was
  // offline) will already be terminal in boltz_swaps but still 'pending'
  // in our invoices table — reconcile those once here so the SDK update
  // path and the bridge's table stay in lockstep.
  await reconcilePendingIncoming(deps.db, deps.wallet, indexer, deps.notify)

  return { swaps }
}

export async function reconcilePendingIncoming(
  db: Database,
  wallet: Wallet,
  indexer: VtxoIndexer,
  notify?: NotifyFn,
): Promise<void> {
  // Reverse swaps that completed before the listener existed (or while the
  // bridge was offline) are already terminal in boltz_swaps but still
  // 'pending' in our transactions table — the SwapManager's resume loop
  // only re-monitors non-final swaps, so the onSwapCompleted callback
  // wouldn't fire for them. Sweep them on boot (and periodically) so the
  // table matches the SDK's view.
  //
  // The outgoing side has its own reconcile (reconcilePendingOutgoing) —
  // submarine sends get their swap_id at settle time once the handler
  // returns, and sub-dust sends are matched to the atomic repo by hash.
  const now = Math.floor(Date.now() / 1000)
  const pending = db
    .query<{ swap_id: string }, []>(
      `SELECT swap_id FROM transactions
         WHERE type = 'incoming' AND state = 'pending' AND swap_id IS NOT NULL`,
    )
    .all()

  for (const row of pending) {
    const swapRow = db
      .query<{ data: string; status: string }, [string]>(
        'SELECT data, status FROM boltz_swaps WHERE id = ?',
      )
      .get(row.swap_id)
    if (!swapRow) continue

    const status = swapRow.status as BoltzSwapStatus
    if (!isReverseFinalStatus(status)) continue

    const newState = isReverseSuccessStatus(status) ? 'settled' : 'failed'
    const swap = JSON.parse(swapRow.data) as BoltzReverseSwap
    // M3: a success reported by boltz isn't proof the Ark side landed. Confirm
    // the on-Ark vtxo before flipping to settled; otherwise defer (leave pending)
    // so a later pass re-confirms. Failed (unpaid expiry) needs no confirm.
    if (newState === 'settled' && !(await confirmReverseLanded(wallet, indexer, swap))) {
      console.warn(
        `boltz: pending incoming ${swap.id} is terminal-settled but the Ark vtxo isn't confirmed yet (M3) — deferring`,
      )
      continue
    }
    // preimage only on success — same rationale as syncSwapToDb's reverse branch.
    const res = db.query(
      `UPDATE transactions
         SET state = ?,
             preimage = COALESCE(preimage, ?),
             settled_at = COALESCE(settled_at, ?)
       WHERE type = 'incoming' AND swap_id = ? AND state = 'pending'`,
    ).run(newState, newState === 'settled' ? swap.preimage : null, now, row.swap_id)
    // Notify only when THIS pass flipped the row (rows-changed gate keeps
    // it exactly-once across restarts); failed = unpaid-expiry noise, skip.
    if (res.changes > 0 && newState === 'settled') {
      notify?.(
        'recv-ln',
        () => `recv: LN invoice settled — ${swap.request.invoiceAmount} sats [swap ${swap.id.slice(0, 8)}]`,
      )
    }
  }

  // (M1) Outgoing side crash-window reconcile: a sub-dust atomic send whose
  // `transactions` row is still pending after a restart resolves against the
  // atomic-repo row (keyed by the same payment hash), so a pay_invoice
  // interrupted between the LN payment and the handler's ledger write settles
  // (or fails) instead of eating budget forever.
  const outgoing = db
    .query<{ id: number; payment_hash: string; amount_msat: number }, []>(
      `SELECT id, payment_hash, amount_msat FROM transactions
         WHERE type = 'outgoing' AND state = 'pending'`,
    )
    .all()
  const repo = new SqliteAtomicSwapRepository(db)
  for (const row of outgoing) {
    const atomic = repo.getByPaymentHash(row.payment_hash)
    if (!atomic || atomic.direction !== SwapDirection.Send) continue
    if (atomic.state === 'claimed') {
      // R2: the live handler bumps connections.spent_msat as part of its settle
      // transaction — the reconcile must do the same for a payment the handler
      // never returned from, or the 'never' budget counter undercounts it. The
      // principal (amount_msat) is what the pending slice already reserved, so
      // bumping exactly that keeps the accounting drift-free (changes-gated so
      // a re-entrant pass never double-counts). One transaction, same invariant
      // as the handler's settle: the flip out of 'pending' and the counter bump
      // must land together or not at all.
      db.transaction(() => {
        const res = db
          .query(
            `UPDATE transactions SET state = 'settled', preimage = COALESCE(preimage, ?), settled_at = ?,
                    fees_paid_msat = COALESCE(fees_paid_msat, 0)
             WHERE id = ? AND state = 'pending'`,
          )
          .run(atomic.preimage ?? null, now, row.id)
        if (res.changes > 0) {
          db.query(
            `UPDATE connections SET spent_msat = spent_msat + ?
             WHERE id = (SELECT connection_id FROM transactions WHERE id = ?)`,
          ).run(row.amount_msat, row.id)
        }
      })()
    } else if (atomic.state === 'refunded' || atomic.state === 'failed' || atomic.state === 'cancelled') {
      db.query(
        `UPDATE transactions SET state = 'failed', settled_at = ? WHERE id = ? AND state = 'pending'`,
      ).run(now, row.id)
    }
    // non-terminal atomic state → still in flight, leave pending
  }
}

/**
 * Reflects a terminal swap event into the bridge's invoices / payments
 * tables. The pay_invoice handler updates the payment row itself when its
 * sendLightningPayment await returns, so this listener is the primary path
 * only for make_invoice — and the backup path for pay_invoice when a swap
 * gets resumed across a process restart (the original handler call never
 * came back).
 *
 * State writes are gated on `state = 'pending'` so a later auto-action
 * can't undo what the synchronous handler already recorded.
 */
export function syncSwapToDb(
  db: Database,
  swap: BoltzSwap,
  state: 'settled' | 'failed',
  errorMessage?: string,
): void {
  const now = Math.floor(Date.now() / 1000)

  if (isPendingReverseSwap(swap)) {
    // preimage only on success: the reverse-swap preimage is locally generated
    // (we're the claimant), so it exists even for an unpaid invoice — writing
    // it to a failed row would let lookup_invoice serve a "proof of payment"
    // for an invoice nobody paid.
    db.query(
      `UPDATE transactions
         SET state = ?,
             preimage = COALESCE(preimage, ?),
             settled_at = COALESCE(settled_at, ?)
       WHERE type = 'incoming' AND swap_id = ? AND state = 'pending'`,
    ).run(state, state === 'settled' ? swap.preimage : null, now, swap.id)
    return
  }

  if (isPendingSubmarineSwap(swap)) {
    db.query(
      `UPDATE transactions
         SET state = ?,
             preimage = COALESCE(preimage, ?),
             error = COALESCE(error, ?),
             settled_at = COALESCE(settled_at, ?)
       WHERE type = 'outgoing' AND swap_id = ? AND state = 'pending'`,
    ).run(state, swap.preimage ?? null, errorMessage ?? null, now, swap.id)
    return
  }

  // Chain swaps aren't surfaced through NWC — silently ignored.
}
