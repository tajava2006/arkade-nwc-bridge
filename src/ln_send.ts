import { decodeInvoice, type ArkadeSwaps } from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'

// Below P2TR dust a Boltz submarine swap can't settle: the vHTLC lockup vtxo is
// sub-dust, arkd marks it VTXO_RECOVERABLE and rejects the claim, so the swap
// strands. Sub-dust sends take boltz's non-atomic plain-send path instead.
const DUST_SATS = 330

export interface LnSendDeps {
  swaps: ArkadeSwaps
  wallet: Wallet
  /** Boltz REST base (no /v2 suffix). */
  boltzApiUrl: string
}

export interface LnSendResult {
  /** sats that left the wallet (invoice + fee) */
  amount: number
  preimage: string
  /** ark txid (submarine swap output, or the sub-dust funding tx) */
  txid: string
}

/**
 * Pay a BOLT11 over Lightning from the Ark wallet — the single LN-send entry
 * point shared by every caller (NWC pay_invoice, dashboard /send LN rail). For
 * amounts >= dust it's the normal Boltz submarine swap. For sub-dust amounts the
 * submarine swap can't settle (vHTLC lockup is sub-dust -> arkd
 * VTXO_RECOVERABLE -> claim strands), so it routes through boltz's non-atomic
 * plain-send path: move a plain vtxo of (invoice + fee) to boltz's ARK address,
 * then ask boltz to pay. No vHTLC, so no swept-vtxo garbage and the send shows
 * up as a normal vtxo. Boltz dedups on the arkTxid, so a replay can't double-pay.
 *
 * Any new LN send entry point MUST go through here, not raw
 * swaps.sendLightningPayment, or it silently regresses sub-dust to the old
 * graceful-abandon path.
 */
export async function sendLightning(deps: LnSendDeps, invoice: string): Promise<LnSendResult> {
  let invoiceSats = 0
  try {
    invoiceSats = decodeInvoice(invoice).amountSats ?? 0
  } catch {
    // let sendLightningPayment surface the decode error with its own messaging
  }

  if (invoiceSats > 0 && invoiceSats < DUST_SATS) {
    return sendSubdust(deps, invoice, invoiceSats)
  }

  const res = await deps.swaps.sendLightningPayment({ invoice })
  return { amount: res.amount, preimage: res.preimage, txid: res.txid }
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

  const { address } = await subdustFetch<{ address: string }>(
    `${deps.boltzApiUrl}/v2/subdust/address`,
  )
  const txid = await deps.wallet.send({ address, amount: sendSats })

  const { preimage } = await subdustFetch<{ paid: boolean; preimage: string }>(
    `${deps.boltzApiUrl}/v2/subdust/send`,
    { arkTxid: txid, invoice },
  )
  return { amount: sendSats, preimage, txid }
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
