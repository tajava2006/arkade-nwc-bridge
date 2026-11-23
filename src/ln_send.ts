import type { Database } from 'bun:sqlite'
import type { Wallet } from '@arkade-os/sdk'
import { SqliteAtomicSwapRepository, SwapDirection } from './atomic'
import { AtomicInsufficientFunds, atomicSubdustSend } from './atomic/send'
import { decodeInvoice } from './lib/bolt11'
import type { NotifyFn } from './nostr/notifier'

/** The Lightning rail: subdustd, for every amount (D11). Absent ⇒ the bridge runs Ark-only. */
export interface LightningRails {
  /** subdustd's API base. */
  subdustdUrl: string
}

export interface LnSendDeps {
  lightning: LightningRails
  wallet: Wallet
  /** ASP (arkd) REST base — the atomic send's server params. */
  arkServerUrl: string
  /** sqlite handle — the atomic send persists its swaps for refund recovery. */
  db: Database
  notify?: NotifyFn
}

export interface LnSendResult {
  /** sats that left the wallet (invoice + fee) */
  amount: number
  preimage: string
  /** ark txid of the funding */
  txid: string
  /** the atomic swap behind it */
  swapId: string
}

/**
 * A payment the rail cannot call either way yet: subdustd had the presigs and
 * never answered, so it may still pay. The caller must leave its ledger row
 * pending — marking it failed would release a reservation for money that may
 * have moved. The atomic reconcile resolves it from the swap row.
 */
export class LnSendUnresolved extends Error {}

/** Refused before any value moved (no swap funded). */
export class LnSendRefused extends Error {
  constructor(
    message: string,
    readonly insufficientFunds = false,
  ) {
    super(message)
  }
}

/**
 * Pay a BOLT11 over Lightning from the Ark wallet — the single LN-send entry
 * point (NWC pay_invoice, dashboard /send). Every amount goes through the
 * atomic send against subdustd (D11): a shared vtxo subdustd can claim only
 * with the preimage (= the invoice paid), else the funding comes back.
 */
export async function sendLightning(deps: LnSendDeps, invoice: string): Promise<LnSendResult> {
  let decoded
  try {
    decoded = decodeInvoice(invoice)
  } catch (e) {
    throw new LnSendRefused(`invalid BOLT11 invoice: ${(e as Error).message}`)
  }
  const sats = decoded.amountSats ?? 0
  if (sats <= 0) throw new LnSendRefused('0-amount invoices are not supported')

  try {
    const r = await atomicSubdustSend(
      {
        wallet: deps.wallet,
        arkServerUrl: deps.arkServerUrl,
        db: deps.db,
        subdustdUrl: deps.lightning.subdustdUrl,
        notify: deps.notify,
      },
      invoice,
      sats,
    )
    return { amount: r.amount, preimage: r.preimage, txid: r.txid, swapId: r.swapId }
  } catch (e) {
    if (e instanceof AtomicInsufficientFunds) throw new LnSendRefused(e.message, true)
    // A throw that leaves the swap ln_inflight means subdustd had the presigs
    // and never answered (a 503/502, a dropped connection): it may still pay.
    const row = new SqliteAtomicSwapRepository(deps.db).getByPaymentHash(decoded.paymentHash)
    if (row?.direction === SwapDirection.Send && row.state === 'ln_inflight') {
      throw new LnSendUnresolved(`payment outcome unknown (${(e as Error).message}) — resolving in the background`)
    }
    throw e
  }
}
