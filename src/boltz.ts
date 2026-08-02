import {
  ArkadeSwaps,
  BoltzSwapProvider,
  decodeInvoice,
  isPendingReverseSwap,
  isPendingSubmarineSwap,
  isReverseFinalStatus,
  isReverseSuccessStatus,
  type BoltzReverseSwap,
  type BoltzSwap,
  type BoltzSwapStatus,
} from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'
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
// recv row settled or hand a payer a 9735 receipt, confirm a vtxo of about the
// landed amount actually showed up on Ark (from the SDK's own wallet view, which
// is fed by the arkd indexer — not boltz). Poll a bounded window (the vtxo can
// land a beat after the settle event); on no confirm we defer so a later
// reconcile pass retries — self-healing, never a false success. The receipt
// therefore can't be forged by boltz claiming success without the Ark side
// landing. Landed ≈ invoice nominal − boltz's reverse fee.
const REVERSE_LAND_POLLS = 4
const REVERSE_LAND_GAP_MS = 1000

function reverseLandedSat(swap: BoltzReverseSwap): number {
  const onchain = swap.response?.onchainAmount
  return typeof onchain === 'number' ? onchain : swap.request.invoiceAmount
}

/**
 * Swap creation time in ms (R3 baseline). Boltz's `createdAt` is unix seconds;
 * tolerate a ms-valued payload so an upstream change can't double-count.
 */
export function swapCreatedMs(swap: { createdAt?: number }): number | undefined {
  const raw = swap.createdAt
  if (raw === undefined || raw === null) return undefined
  return raw > 1e12 ? raw : raw * 1000
}

export async function confirmReverseLanded(
  wallet: Wallet,
  expectedSat: number,
  sinceMs?: number,
): Promise<boolean> {
  if (!(expectedSat > 0)) return false
  const tol = Math.max(2, Math.ceil(expectedSat * 0.02))
  for (let i = 0; i < REVERSE_LAND_POLLS; i++) {
    try {
      const vtxos = await wallet.getVtxos({ withRecoverable: true })
      // R3: value-approx alone can false-positive on a *previous* same-amount
      // vtxo (e.g. repeated 21-sat zaps) — boltz lying about swap #2 would
      // still match swap #1's vtxo. Requiring the vtxo to have been created
      // at/after this swap was created distinguishes the actual landing.
      const hit = (v: { value: number; createdAt?: Date }): boolean =>
        Math.abs(v.value - expectedSat) <= tol &&
        (sinceMs === undefined || (v.createdAt !== undefined && v.createdAt.getTime() >= sinceMs))
      if (vtxos.some(hit)) return true
    } catch {
      // transient wallet/indexer read failure — retry the poll
    }
    await new Promise((r) => setTimeout(r, REVERSE_LAND_GAP_MS))
  }
  return false
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
        onSwapCompleted: async (swap) => {
          // M3: for reverse (inbound) swaps, don't mark settled / don't ack the
          // payer until the Ark vtxo has actually landed (boltz's word isn't
          // evidence). Deferred ones self-heal via the periodic reconcile.
          if (isPendingReverseSwap(swap)) {
            const landed = await confirmReverseLanded(
              deps.wallet,
              reverseLandedSat(swap),
              swapCreatedMs(swap),
            )
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
          }
          syncSwapToDb(deps.db, swap, 'settled')
          if (deps.onReverseSettled && isPendingReverseSwap(swap)) deps.onReverseSettled(swap)
          if (isPendingSubmarineSwap(swap)) {
            deps.notify?.('send-ln', () => {
              const nominal = decodeInvoice(swap.request.invoice).amountSats
              const fee = swap.response.expectedAmount - nominal
              return `send: LN paid — ${nominal} sats (+${fee} fee) [swap ${swap.id.slice(0, 8)}]`
            })
          }
        },
        onSwapFailed: (swap, error) => {
          syncSwapToDb(deps.db, swap, 'failed', error.message)
          // Submarine only: a failed reverse swap is an unpaid invoice
          // expiring — routine noise, deliberately not notified.
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
  await reconcilePendingIncoming(deps.db, deps.wallet, deps.notify)

  return { swaps }
}

export async function reconcilePendingIncoming(
  db: Database,
  wallet: Wallet,
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
    if (newState === 'settled' && !(await confirmReverseLanded(wallet, reverseLandedSat(swap), swapCreatedMs(swap)))) {
      console.warn(
        `boltz: pending incoming ${swap.id} is terminal-settled but the Ark vtxo isn't confirmed yet (M3) — deferring`,
      )
      continue
    }
    const res = db.query(
      `UPDATE transactions
         SET state = ?,
             preimage = COALESCE(preimage, ?),
             settled_at = COALESCE(settled_at, ?)
       WHERE type = 'incoming' AND swap_id = ? AND state = 'pending'`,
    ).run(newState, swap.preimage, now, row.swap_id)
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
    } else if (atomic.state === 'refunded' || atomic.state === 'failed') {
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
    db.query(
      `UPDATE transactions
         SET state = ?,
             preimage = COALESCE(preimage, ?),
             settled_at = COALESCE(settled_at, ?)
       WHERE type = 'incoming' AND swap_id = ? AND state = 'pending'`,
    ).run(state, swap.preimage, now, swap.id)
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
