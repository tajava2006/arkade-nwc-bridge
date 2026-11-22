import type { Database } from 'bun:sqlite'
import { decodeInvoice } from './lib/bolt11'
import type { Wallet } from '@arkade-os/sdk'
import { issueAtomicReceive, driveAtomicReceives, type AtomicReceiveDeps } from './atomic/receive'
import { SqliteAtomicSwapRepository, SwapDirection } from './atomic'
import type { NotifyFn } from './nostr/notifier'

// Every LN receive is an ATOMIC receive against subdustd, whatever the amount
// (D10): the bridge generates the preimage, subdustd mints a HOLD invoice
// (carrying the NIP-57 description hash when given — the solver's cannot),
// funds a shared vtxo once the payer's HTLC is held, and we claim with our own
// preimage. The bridge owns the preimage, so receipts use it directly.

export interface LnReceiveDeps {
  /** Ark wallet — the receive claims to its address; wallet.identity signs. */
  wallet: Wallet
  /** subdustd's API base. */
  subdustdUrl: string
  /** ASP (arkd) REST base — the claim needs server params. */
  arkServerUrl: string
  /** sqlite handle — atomic receives persist for restart-safe claiming. */
  db: Database
  /** Operator DM sink — passed through to the atomic receive driver. */
  notify?: NotifyFn
}

function atomicDeps(deps: LnReceiveDeps): AtomicReceiveDeps {
  return { identity: deps.wallet.identity, arkServerUrl: deps.arkServerUrl, db: deps.db, boltzApiUrl: deps.subdustdUrl, notify: deps.notify }
}

export interface IssueInvoiceParams {
  amountSats: number
  description?: string
  /**
   * SHA256 (hex, 32 bytes) committed into the BOLT11 instead of a plaintext
   * description — NIP-57 zaps hash the zap request so the 9735 receipt
   * verifies. Wins over `description` when both are set (a BOLT11 carries one
   * or the other, never both).
   */
  descriptionHash?: string
}

/**
 * Absolute BOLT11 expiry (unix secs). decodeInvoice().expiry is documented as
 * an absolute timestamp but actually returns the raw relative `x`-tag seconds:
 * light-bolt11-decoder defines an absolute getter, then its TAGCODES
 * defineProperty loop clobbers it with the raw section value. Normalize by
 * magnitude so an upstream fix can't double-count.
 */
export function absoluteExpiry(invoice: string): number {
  const decoded = decodeInvoice(invoice)
  return decoded.expiry > 1e9 ? decoded.expiry : decoded.timestamp + decoded.expiry
}

export interface IssuedInvoice {
  /** Always 'subdust' — the atomic receive; kept as a tag for the callers' branches. */
  kind: 'subdust'
  invoice: string
  paymentHash: string
  /** Absolute Unix seconds after which the BOLT11 can no longer be paid. */
  expiresAt: number
  /** Sats that land on Ark when paid: the nominal, 1:1 (no fee on receives). */
  receivedSats: number
  swapId: string
  preimage: string
}

/**
 * Mint a BOLT11 that lands on Ark — the single LN-receive entry point (CLINK
 * offers, NWC make_invoice). Atomic either way it ends: the preimage is
 * revealed only by our claim, so either the payer is settled and the vtxo is
 * ours, or T passes and subdustd refunds the payer — never debited without
 * the vtxo arriving (ATOMIC_SUBDUST_PLAN.md §3).
 *
 * Any new LN receive entry point MUST go through here.
 */
export async function issueInvoice(deps: LnReceiveDeps, params: IssueInvoiceParams): Promise<IssuedInvoice> {
  const { amountSats, description, descriptionHash } = params
  const r = await issueAtomicReceive(atomicDeps(deps), amountSats, descriptionHash, description)
  return {
    kind: 'subdust',
    invoice: r.invoice,
    paymentHash: r.paymentHash,
    expiresAt: absoluteExpiry(r.invoice),
    receivedSats: amountSats,
    swapId: r.swapId,
    preimage: r.preimage,
  }
}

// An HTLC accepted moments before the BOLT11's expiry can still settle right
// after it; the cosmetic pending→expired flip waits this long past expires_at.
const EXPIRY_GRACE_SECONDS = 15 * 60

/**
 * Boot + periodic pass for atomic sub-dust receives. Two jobs:
 *  1. drive every non-terminal receive swap (poll boltz status → once funded,
 *     verify-before-act, claim revealing our preimage, then settle boltz's hold
 *     invoice) — restart-safe, so a swap boltz funded while we were down resumes.
 *  2. flip the matching `transactions` row (NWC make_invoice, swap_id IS NULL)
 *     to settled with our own preimage, or to expired once the grace passes.
 *  3. terminalize never-funded receives past their invoice expiry (below).
 * CLINK 9735 receipts read the same settled swaps (reconcileClinkAcks).
 */
/** Absolute BOLT11 expiry (unix secs); injectable so the sweep is unit-testable. */
export type ExpiryDecoder = (invoice: string) => number

/**
 * Terminalize never-funded receives past their invoice expiry. A receive stuck
 * at `invoice_issued` (boltz never funded — empty mini-wallet, or the old
 * funding bug) can't complete: its held hold-invoice htlc just times out and
 * refunds the payer. Without this, driveAtomicReceives polls its status every
 * tick forever. Keyed off the invoice's own expiry (decoded from the stored
 * BOLT11), so it covers both NWC and CLINK receives (only NWC has a
 * `transactions` row). funded/claimed are in-flight and left alone (boltz
 * refunds funded past T; claimed retries settle). Returns the swept swap ids.
 */
export function sweepExpiredAtomicReceives(
  db: Database,
  nowSec: number,
  decodeExpiry: ExpiryDecoder = absoluteExpiry,
): string[] {
  const repo = new SqliteAtomicSwapRepository(db)
  const swept: string[] = []
  for (const swap of repo.listResumable()) {
    if (swap.direction !== SwapDirection.Receive || swap.state !== 'invoice_issued' || !swap.invoice) continue
    let expiry: number
    try {
      expiry = decodeExpiry(swap.invoice)
    } catch {
      continue // undecodable invoice — leave it, don't guess
    }
    if (nowSec > expiry + EXPIRY_GRACE_SECONDS) {
      repo.transition(swap.id, 'failed')
      swept.push(swap.id)
    }
  }
  return swept
}

/**
 * Returns the payment hashes of receives that settled THIS pass, so the
 * caller can ack them immediately (clink sendSubdustAck) instead of waiting
 * for the next reconcile tick — pre-settled swaps are the reconcile loop's
 * catch-up job, not ours.
 */
export async function reconcileAtomicReceives(deps: LnReceiveDeps): Promise<string[]> {
  const settledIds = await driveAtomicReceives(atomicDeps(deps))

  const repo = new SqliteAtomicSwapRepository(deps.db)
  const now = Math.floor(Date.now() / 1000)

  for (const id of sweepExpiredAtomicReceives(deps.db, now)) {
    console.log(`nwc: atomic sub-dust receive ${id.slice(0, 8)}… invoice expired, never funded → failed`)
  }
  const rows = deps.db
    .query<{ id: number; payment_hash: string; expires_at: number | null }, []>(
      `SELECT id, payment_hash, expires_at FROM transactions
         WHERE type = 'incoming' AND state = 'pending' AND swap_id IS NULL`,
    )
    .all()
  for (const row of rows) {
    const swap = repo.getByPaymentHash(row.payment_hash)
    if (swap?.direction === SwapDirection.Receive && swap.state === 'settled') {
      deps.db
        .query(
          `UPDATE transactions
             SET state = 'settled', preimage = COALESCE(preimage, ?), settled_at = COALESCE(settled_at, ?)
           WHERE id = ? AND state = 'pending'`,
        )
        .run(swap.preimage ?? null, now, row.id)
      console.log(`nwc: atomic sub-dust ${row.payment_hash.slice(0, 8)}… settled`)
    } else if (row.expires_at !== null && now > row.expires_at + EXPIRY_GRACE_SECONDS) {
      deps.db.query(`UPDATE transactions SET state = 'expired' WHERE id = ? AND state = 'pending'`).run(row.id)
    }
  }

  return settledIds.flatMap((id) => {
    const hash = repo.get(id)?.paymentHash
    return hash ? [hash] : []
  })
}
