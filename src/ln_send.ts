import { decodeInvoice, type ArkadeSwaps } from '@arkade-os/boltz-swap'
import { isSubdust, type Wallet } from '@arkade-os/sdk'

// Below P2TR dust a Boltz submarine swap can't settle: the vHTLC lockup vtxo is
// sub-dust, arkd marks it VTXO_RECOVERABLE and rejects the claim, so the swap
// strands. Sub-dust sends take boltz's non-atomic plain-send path instead.
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
 * VTXO_RECOVERABLE -> claim strands), so it routes through boltz's non-atomic
 * plain-send path: move a plain vtxo of (invoice + fee) to boltz's ARK address,
 * then ask boltz to pay. No vHTLC, so no swept-vtxo garbage and the send shows
 * up as a normal vtxo. Boltz dedups on the arkTxid, so a replay can't double-pay.
 *
 * Both paths fund all-in when the whole balance is within DRAIN_SLACK_SATS of
 * the requirement, so a drain invoice (send.ts lnDrainInvoiceSat) empties the
 * wallet instead of stranding a sub-dust change vtxo.
 *
 * Any new LN send entry point MUST go through here, not raw
 * swaps.sendLightningPayment — that helper funds exactly expectedAmount
 * (re-stranding drain residue) and silently regresses sub-dust to the old
 * graceful-abandon path.
 */
export async function sendLightning(deps: LnSendDeps, invoice: string): Promise<LnSendResult> {
  let invoiceSats = 0
  try {
    invoiceSats = decodeInvoice(invoice).amountSats ?? 0
  } catch {
    // let createSubmarineSwap surface the decode error with its own messaging
  }

  if (invoiceSats > 0 && invoiceSats < DUST_SATS) {
    return sendSubdust(deps, invoice, invoiceSats)
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

async function sendSubdust(
  deps: LnSendDeps,
  invoice: string,
  invoiceSats: number,
): Promise<LnSendResult> {
  // Match what a normal submarine swap would charge so boltz still collects its
  // fee; boltz absorbs any routing over that. (Miner/fixed fee not added here —
  // for sub-dust it's negligible and boltz's check is `>= invoice`.)
  const fees = await deps.swaps.getFees()
  const feeSats = Math.ceil((invoiceSats * fees.submarine.percentage) / 100)
  const sendSats = invoiceSats + feeSats

  // Per-invoice funding address: Boltz derives it from this invoice's payment
  // hash, so the funding we're about to make can only ever pay THIS invoice (a
  // vtxo Boltz holds for any other reason won't match). See SubdustRouter.
  const { address } = await subdustFetch<{ address: string }>(
    `${deps.boltzApiUrl}/v2/subdust/address?invoice=${encodeURIComponent(invoice)}`,
  )
  // Our own address — boltz plain-sends the funding back here if the LN payment
  // fails terminally (refund-on-failure).
  const refundAddress = await deps.wallet.getAddress()
  // Boltz only requires funding >= invoice principal and keeps the surplus as
  // margin, so the all-in drain costs nothing beyond the residue itself.
  const funding = fundingAmount(sendSats, await spendableSats(deps.wallet))
  const txid = await deps.wallet.send({ address, amount: funding })

  const { preimage } = await subdustFetch<{ paid: boolean; preimage: string }>(
    `${deps.boltzApiUrl}/v2/subdust/send`,
    { arkTxid: txid, invoice, refundAddress },
  )
  return { amount: funding, preimage, txid }
}

async function subdustFetch<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as T
}
