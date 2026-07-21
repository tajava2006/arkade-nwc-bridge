import type { Database } from 'bun:sqlite'
import { decodeInvoice, type ArkadeSwaps } from '@arkade-os/boltz-swap'
import { isSubdust, type Wallet } from '@arkade-os/sdk'
import { atomicSubdustSend } from './atomic_send'

// Below P2TR dust a Boltz submarine swap can't settle: the vHTLC lockup vtxo is
// sub-dust, arkd marks it VTXO_RECOVERABLE and rejects the claim, so the swap
// strands. Sub-dust sends take the atomic sub-dust path instead (atomic_send.ts).
const DUST_SATS = 330

/**
 * Residue up to this many sats above the required funding is folded into the
 * swap (boltz keeps it as margin) instead of being left behind: change below
 * dust becomes an OP_RETURN sub-dust vtxo — stranded until a round — which is
 * strictly worse than donating 1–2 sats. The 2-sat width covers a ±1
 * disagreement between our mirrored fee ceil (send.ts lnDrainInvoiceSat) and
 * the server's at float boundaries. Anything larger stays in the wallet as
 * normal change: donating e.g. 300 sats would cost more than the recoverable
 * sub-dust it avoids.
 */
const DRAIN_SLACK_SATS = 2

export interface LnSendDeps {
  swaps: ArkadeSwaps
  wallet: Wallet
  /** Boltz REST base (no /v2 suffix). */
  boltzApiUrl: string
  /** ASP (arkd) REST base — the atomic sub-dust send needs server params. */
  arkServerUrl: string
  /** sqlite handle — the atomic sub-dust send persists swaps for refund recovery. */
  db: Database
}

export interface LnSendResult {
  /** sats that left the wallet (invoice + fee, incl. any drain residue) */
  amount: number
  preimage: string
  /** ark txid (submarine swap funding, or the sub-dust funding tx) */
  txid: string
}

/**
 * What an offchain send can actually pull: the wallet.send selection pool
 * (`withRecoverable: false` drops swept/expired) minus fresh sub-dust, which
 * stays in that pool but can only be consumed by a settlement round.
 */
async function spendableSats(wallet: Wallet): Promise<number> {
  const vtxos = await wallet.getVtxos({ withRecoverable: false })
  let sum = 0
  for (const v of vtxos) {
    if (!isSubdust(v, BigInt(DUST_SATS))) sum += v.value
  }
  return sum
}

/**
 * Full balance when it's within DRAIN_SLACK_SATS of the required funding
 * (empties the wallet, boltz keeps the residue), the exact requirement
 * otherwise. Throws early with a readable message when the balance doesn't
 * cover the requirement — wallet.send's own "Selected VTXOs do not cover"
 * doesn't say how much is missing or why (sub-dust/swept not being usable is
 * the common surprise).
 */
function fundingAmount(requiredSat: number, spendableSat: number): number {
  if (requiredSat > spendableSat) {
    throw new Error(
      `LN send needs ${requiredSat} sats (invoice + fee) but only ${spendableSat} sats are ` +
        `offchain-spendable — sub-dust/swept funds don't count until a Refresh`,
    )
  }
  const surplus = spendableSat - requiredSat
  return surplus > 0 && surplus <= DRAIN_SLACK_SATS ? spendableSat : requiredSat
}

/**
 * Pay a BOLT11 over Lightning from the Ark wallet — the single LN-send entry
 * point shared by every caller (NWC pay_invoice, dashboard /send LN rail). For
 * amounts >= dust it's a Boltz submarine swap. For sub-dust amounts the
 * submarine swap can't settle (vHTLC lockup is sub-dust -> arkd
 * VTXO_RECOVERABLE -> claim strands), so it routes through the atomic sub-dust
 * path (atomic_send.ts): fund a shared 4-leaf vtxo whole-input, hand boltz a
 * pre-signed claim, and let it pay the invoice only against that. No vHTLC, so
 * no swept-vtxo garbage, and the funder's remainder comes back as one regular
 * vtxo. Atomicity holds either way — boltz pays and claims, or T passes and we
 * refund ourselves; it cannot take the funding without paying.
 *
 * Both paths fund all-in when the whole balance is within DRAIN_SLACK_SATS of
 * the requirement, so a drain invoice (send.ts lnDrainInvoiceSat) empties the
 * wallet instead of stranding a sub-dust change vtxo.
 *
 * Any new LN send entry point MUST go through here, not raw
 * swaps.sendLightningPayment — that helper funds exactly expectedAmount
 * (re-stranding drain residue) and pushes sub-dust amounts into a submarine
 * swap that cannot settle, bypassing the atomic path entirely.
 */
export async function sendLightning(deps: LnSendDeps, invoice: string): Promise<LnSendResult> {
  let invoiceSats = 0
  try {
    invoiceSats = decodeInvoice(invoice).amountSats ?? 0
  } catch {
    // let createSubmarineSwap surface the decode error with its own messaging
  }

  if (invoiceSats > 0 && invoiceSats < DUST_SATS) {
    return atomicSubdustSend(
      { wallet: deps.wallet, arkServerUrl: deps.arkServerUrl, db: deps.db, boltzApiUrl: deps.boltzApiUrl },
      invoice,
      invoiceSats,
    )
  }
  return sendSubmarine(deps, invoice)
}

/**
 * Submarine swap, hand-assembled from the same public pieces
 * swaps.sendLightningPayment uses (create -> fund -> wait) purely so the
 * funding amount can be the full balance on a near-drain: boltz accepts
 * overpay up to max(10k sats, 2%) on submarine lockups (OverpaymentProtector)
 * and simply keeps it. Failure handling is unchanged from the SDK helper —
 * its in-method refund path is dead code per its own docstring; refundable
 * failures are auto-refunded by the SwapManager (enabled in boltz.ts). A
 * throw before wallet.send leaves only an unfunded swap row, which boltz
 * expires server-side.
 */
async function sendSubmarine(deps: LnSendDeps, invoice: string): Promise<LnSendResult> {
  const pending = await deps.swaps.createSubmarineSwap({ invoice })
  const { address, expectedAmount } = pending.response
  if (!address) {
    throw new Error(`Swap ${pending.id}: missing address in submarine swap response`)
  }

  const amount = fundingAmount(expectedAmount, await spendableSats(deps.wallet))
  const txid = await deps.wallet.send({ address, amount })
  const { preimage } = await deps.swaps.waitForSwapSettlement(pending)
  return { amount, preimage, txid }
}

