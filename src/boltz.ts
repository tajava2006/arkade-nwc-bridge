import {
  ArkadeSwaps,
  BoltzSwapProvider,
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
import type { Config } from './config'

export interface BoltzContext {
  swaps: ArkadeSwaps
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
        onSwapCompleted: (swap) => {
          syncSwapToDb(deps.db, swap, 'settled')
          if (deps.onReverseSettled && isPendingReverseSwap(swap)) deps.onReverseSettled(swap)
        },
        onSwapFailed: (swap, error) => syncSwapToDb(deps.db, swap, 'failed', error.message),
      },
    },
  })

  // ArkadeSwaps.create rehydrates pending swaps from the repository and the
  // SwapManager resume loop only re-monitors *non-final* swaps. Anything
  // that completed before the listener existed (or while the bridge was
  // offline) will already be terminal in boltz_swaps but still 'pending'
  // in our invoices table — reconcile those once here so the SDK update
  // path and the bridge's table stay in lockstep.
  reconcilePendingIncoming(deps.db)

  return { swaps }
}

function reconcilePendingIncoming(db: Database): void {
  // Reverse swaps that completed before the listener existed (or while the
  // bridge was offline) are already terminal in boltz_swaps but still
  // 'pending' in our transactions table — the SwapManager's resume loop
  // only re-monitors non-final swaps, so the onSwapCompleted callback
  // wouldn't fire for them. Sweep them on boot so the table matches the
  // SDK's view.
  //
  // The outgoing side doesn't need this: pay_invoice updates the row
  // synchronously when sendLightningPayment returns or throws. The only
  // window for drift is a crash mid-await, which is deferred to the phase
  // 10 cleanup pass.
  const now = Math.floor(Date.now() / 1000)
  const pending = db
    .query<{ swap_id: string }, []>(
      `SELECT swap_id FROM transactions
         WHERE type = 'incoming' AND state = 'pending' AND swap_id IS NOT NULL`,
    )
    .all()

  let reconciled = 0
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
    db.query(
      `UPDATE transactions
         SET state = ?,
             preimage = COALESCE(preimage, ?),
             settled_at = COALESCE(settled_at, ?)
       WHERE type = 'incoming' AND swap_id = ? AND state = 'pending'`,
    ).run(newState, swap.preimage, now, row.swap_id)
    reconciled++
  }

  if (reconciled > 0) {
    console.log(`boltz: reconciled ${reconciled} stale pending incoming row(s)`)
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
function syncSwapToDb(
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
