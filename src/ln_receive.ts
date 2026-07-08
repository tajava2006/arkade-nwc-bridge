import type { Database } from 'bun:sqlite'
import { decodeInvoice, type ArkadeSwaps } from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'

// Bitcoin P2TR standard dust. Below this a Boltz reverse swap can't settle: the
// vHTLC lockup vtxo is sub-dust, arkd marks it VTXO_RECOVERABLE and rejects the
// claim's spend, so the swap strands. Sub-dust receives take boltz's
// plain-invoice path instead (patches/boltz-subdust-api.patch).
const DUST_SATS = 330

export interface LnReceiveDeps {
  swaps: ArkadeSwaps
  /** Ark wallet — sub-dust receives are paid out to its address by Boltz. */
  wallet: Wallet
  /** Boltz REST base (no /v2 suffix); the sub-dust receive routes live there. */
  boltzApiUrl: string
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

export type IssuedInvoice = {
  invoice: string
  paymentHash: string
  /** Absolute Unix seconds after which the BOLT11 can no longer be paid. */
  expiresAt: number
  /**
   * Sats that land on Ark when paid: invoice nominal minus the swap
   * provider's fee for the reverse-swap path, exactly the nominal (1:1, no
   * swap fee) for sub-dust.
   */
  receivedSats: number
} & ({ kind: 'subdust' } | { kind: 'swap'; swapId: string })

/**
 * Mint a BOLT11 that lands on Ark — the single LN-receive entry point shared
 * by every caller (CLINK offers, NWC make_invoice). For amounts >= dust it's a
 * Boltz reverse swap: on payment the SwapManager (boltz.ts) auto-claims the
 * VHTLC into the Ark wallet. For sub-dust amounts a reverse swap can't settle,
 * so it routes through boltz's non-atomic plain-invoice path: boltz collects
 * the invoice itself and, on settlement, plain-sends the amount to the wallet
 * address — 1:1, no swap object, no swap fee.
 *
 * The plain path drops the reverse swap's atomicity: the external payer
 * settles a real invoice with no on-chain guarantee, trusting Boltz to
 * deliver the vtxo afterward. The counterparty risk is the payer's; below
 * dust there is no atomic alternative anyway, and the amounts are tiny.
 *
 * Sub-dust limitation: boltz's receive route takes only
 * amount/address/descriptionHash, so a plaintext `description` is dropped on
 * that branch (same trade-off CLINK has always made).
 *
 * Any new LN receive entry point MUST go through here, not raw
 * swaps.createLightningInvoice — that mints a reverse swap unconditionally,
 * and a sub-dust reverse swap strands on claim.
 */
export async function issueInvoice(
  deps: LnReceiveDeps,
  params: IssueInvoiceParams,
): Promise<IssuedInvoice> {
  const { amountSats, description, descriptionHash } = params

  if (amountSats < DUST_SATS) {
    const address = await deps.wallet.getAddress()
    const invoice = await requestSubdustInvoice(deps.boltzApiUrl, amountSats, address, descriptionHash)
    const decoded = decodeInvoice(invoice)
    return {
      kind: 'subdust',
      invoice,
      paymentHash: decoded.paymentHash,
      expiresAt: decoded.expiry,
      receivedSats: amountSats,
    }
  }

  const result = await deps.swaps.createLightningInvoice({
    amount: amountSats,
    description,
    descriptionHash,
  })
  return {
    kind: 'swap',
    invoice: result.invoice,
    paymentHash: result.paymentHash,
    expiresAt: result.expiry,
    receivedSats: result.amount,
    swapId: result.pendingSwap.id,
  }
}

async function requestSubdustInvoice(
  boltzApiUrl: string,
  amount: number,
  address: string,
  descriptionHash?: string,
): Promise<string> {
  const res = await fetch(`${boltzApiUrl}/v2/subdust/receive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount, address, ...(descriptionHash ? { descriptionHash } : {}) }),
  })
  if (!res.ok) {
    throw new Error(`subdust/receive ${res.status}: ${await res.text().catch(() => '')}`)
  }
  const body = (await res.json()) as { invoice?: string }
  if (!body.invoice) throw new Error('subdust/receive: response had no invoice')
  return body.invoice
}

/** Boltz's view of a plain sub-dust invoice: settled (with preimage) or not. */
export async function subdustReceiveStatus(
  boltzApiUrl: string,
  paymentHash: string,
): Promise<{ settled: boolean; preimage?: string }> {
  const res = await fetch(`${boltzApiUrl}/v2/subdust/receive/status?paymentHash=${paymentHash}`)
  if (!res.ok) throw new Error(`subdust status ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()) as { settled: boolean; preimage?: string }
}

// An HTLC accepted moments before the BOLT11's expiry can still settle right
// after it, so the cosmetic pending→expired flip waits this long past
// expires_at. Settlement is checked first each pass, so the grace only delays
// the flip, never loses a payment.
const EXPIRY_GRACE_SECONDS = 15 * 60

/**
 * Boot + periodic reconciler for NWC make_invoice sub-dust rows. The plain
 * path has no swap object, so nothing fires on settlement (the vtxo just
 * arrives in the wallet) — without this pass a sub-dust transactions row
 * stays 'pending' forever for a client that never polls lookup_invoice, and
 * list_transactions would report stale state. ≥dust rows don't need it:
 * onSwapCompleted → syncSwapToDb flips them live and reconcilePendingIncoming
 * covers restarts (both in boltz.ts).
 *
 * `type='incoming' AND swap_id IS NULL` is exactly the sub-dust invoice set —
 * every other incoming row carries its reverse swap's id.
 *
 * settled_at is the reconcile time, not the LN settle time (the status
 * endpoint doesn't report one) — same ±one-tick approximation the CLINK ack
 * reconciler lives with. Best-effort: one row failing (boltz down) is left
 * pending and retried next pass.
 */
export async function reconcileSubdustReceives(deps: {
  db: Database
  boltzApiUrl: string
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const rows = deps.db
    .query<{ id: number; payment_hash: string; expires_at: number | null }, []>(
      `SELECT id, payment_hash, expires_at FROM transactions
         WHERE type = 'incoming' AND state = 'pending' AND swap_id IS NULL`,
    )
    .all()

  for (const row of rows) {
    try {
      const status = await subdustReceiveStatus(deps.boltzApiUrl, row.payment_hash)
      if (status.settled) {
        deps.db
          .query(
            `UPDATE transactions
               SET state = 'settled',
                   preimage = COALESCE(preimage, ?),
                   settled_at = COALESCE(settled_at, ?)
             WHERE id = ? AND state = 'pending'`,
          )
          .run(status.preimage ?? null, now, row.id)
        console.log(`nwc: sub-dust invoice ${row.payment_hash.slice(0, 8)}… settled`)
      } else if (row.expires_at !== null && now > row.expires_at + EXPIRY_GRACE_SECONDS) {
        deps.db
          .query(`UPDATE transactions SET state = 'expired' WHERE id = ? AND state = 'pending'`)
          .run(row.id)
      }
    } catch (err) {
      console.warn(`nwc: sub-dust invoice reconcile failed for ${row.payment_hash.slice(0, 8)}…:`, err)
    }
  }
}
