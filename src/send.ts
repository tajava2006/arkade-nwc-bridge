import {
  canRecoverOnchain,
  Estimator,
  isSubdust,
  isVtxoExpiringSoon,
  isVtxoSpent,
  isValidArkAddress,
  type ExtendedVirtualCoin,
  type OperatorInfo,
} from '@arkade-os/sdk'
import { getJson } from './atomic/http'
import { sendFeeSats } from './atomic/fees'
import { decodeInvoice } from './lib/bolt11'
import { decode as decodeBolt11 } from 'light-bolt11-decoder'

// Pure send-side logic shared by the web routes and views: destination → rail
// classification, VTXO bucketing (rail-aware availability), and the
// onchain-output fee preview. The actual rail calls (wallet.send /
// swaps.sendLightningPayment / Ramps.offboard) live in the route handlers —
// see SEND_DESIGN.md for the why behind the three rails.

// 'clink' is a noffer (CLINK Offers): not a payment rail of its own, but a
// deferred bolt11 source — the review step resolves it to an invoice and then
// pays it over Lightning. See SEND_DESIGN.md §9.
export type Rail = 'lightning' | 'ark' | 'onchain' | 'clink'

/**
 * Classify a pasted destination. Order matters: noffer first (unambiguous
 * `noffer1` prefix), then bolt11 (an invoice is unambiguous), then Ark address,
 * else assume onchain — the offboard path validates the onchain address when it
 * decodes it, so we don't re-implement BTC address parsing here just for routing.
 */
export function classifyDestination(raw: string): Rail | null {
  const dest = raw.trim()
  if (!dest) return null
  if (dest.toLowerCase().startsWith('noffer1')) return 'clink'
  try {
    const decoded = decodeInvoice(dest)
    if (decoded) return 'lightning'
  } catch {
    // not a bolt11 invoice — fall through
  }
  if (isValidArkAddress(dest)) return 'ark'
  return 'onchain'
}

/**
 * The reads the /send breakdown needs, fetched together. The preview asks
 * subdustd for its fee rule again when an invoice is pasted; this copy only
 * feeds the "empty the wallet over Lightning" hint.
 */
export interface SendData {
  arkInfo: OperatorInfo
  vtxos: ExtendedVirtualCoin[]
  /** subdustd's send fee rule; null without Lightning or when subdustd didn't answer. */
  lnFeePercent: number | null
}

export interface VtxoBuckets {
  /** Offchain-spendable: usable on Ark send / LN / offboard. */
  spendable: ExtendedVirtualCoin[]
  /** Sub-dust (value < dust): offboard/refresh only, never offchain input. */
  subdust: ExtendedVirtualCoin[]
  /** Swept or expired: recoverable via a round only. */
  recoverable: ExtendedVirtualCoin[]
  /** Sats totals (sat units, not msat). */
  spendableSat: number
  subdustSat: number
  recoverableSat: number
  /** Everything a round can sweep = spendable + subdust + recoverable. */
  roundTotalSat: number
}

/**
 * Bucket VTXOs by what rail can actually spend them. `vtxos` should come from
 * `wallet.getVtxos({ withRecoverable: true })` so sub-dust / swept ones are
 * present to classify. See SEND_DESIGN.md §7 — availability is rail-dependent,
 * so don't derive it from WalletBalance.
 */
export function classifyVtxos(vtxos: ExtendedVirtualCoin[], dust: bigint): VtxoBuckets {
  const spendable: ExtendedVirtualCoin[] = []
  const subdust: ExtendedVirtualCoin[] = []
  const recoverable: ExtendedVirtualCoin[] = []

  // SDK 0.5 port (money path — balance buckets): 0.4's isSpendable / isRecoverable /
  // isExpired became flat flags + capability predicates. Same buckets: skip
  // spent (and unrolled — the F24 boundary already drops those upstream),
  // sub-dust first, then swept-or-expired (= canRecoverOnchain) as recoverable.
  const now = { timestamp: new Date() }
  for (const v of vtxos) {
    if (isVtxoSpent(v) || v.isUnrolled) continue
    // Sub-dust label takes priority over swept/expired: a sub-dust vtxo is
    // sub-dust regardless of its expiry, and that's the more useful thing to
    // surface. Both buckets are round-only recoverable, so this only changes
    // the display label, not behavior.
    if (isSubdust(v, dust)) {
      subdust.push(v)
    } else if (canRecoverOnchain(v, now)) {
      recoverable.push(v)
    } else {
      spendable.push(v)
    }
  }

  const sum = (xs: ExtendedVirtualCoin[]): number => xs.reduce((acc, v) => acc + v.value, 0)
  const spendableSat = sum(spendable)
  const subdustSat = sum(subdust)
  const recoverableSat = sum(recoverable)
  return {
    spendable,
    subdust,
    recoverable,
    spendableSat,
    subdustSat,
    recoverableSat,
    roundTotalSat: spendableSat + subdustSat + recoverableSat,
  }
}

export function isExpiringSoon(v: ExtendedVirtualCoin): boolean {
  // thresholdMs ≤ 100 makes the SDK fall back to its 3-day default.
  return isVtxoExpiringSoon(v, 0)
}

/**
 * The arkd `onchain-output` intent fee an offboard of `amountSat` would incur.
 *
 * NOTE: evaluated with an empty output script. The realistic fee programs (flat
 * or amount-proportional, per FEE_MODEL.md) don't reference `script`, so this is
 * exact for them; a script-dependent program would make this a slight estimate.
 * The fee actually deducted is whatever `Ramps.offboard` computes at round time
 * — this is only the pre-submit preview.
 */
export function offboardFeeSat(arkInfo: OperatorInfo, amountSat: number): number {
  const estimator = new Estimator(arkInfo.fees.intentFee)
  const fee = estimator.evalOnchainOutput({ amount: BigInt(amountSat), script: '' })
  return Number(fee.satoshis)
}

/**
 * Max sats sendable to an onchain address (full drain). All VTXOs incl.
 * sub-dust + swept go in (offboard pulls `withRecoverable: true`), and the
 * offchain-input fee is a hard-zero by policy so there's no per-input
 * deduction — only the single onchain-output fee comes off the top. Returns
 * null if the result would be below dust (no valid output → genuinely stuck).
 */
export function offboardMaxSat(arkInfo: OperatorInfo, buckets: VtxoBuckets): number | null {
  const fee = offboardFeeSat(arkInfo, buckets.roundTotalSat)
  const out = buckets.roundTotalSat - fee
  if (out < Number(arkInfo.dust)) return null
  return out
}

export interface OffboardDustChange {
  /** The sub-dust change the requested amount would leave. */
  changeSat: number
  /** Largest recipient amount that still leaves ≥ dust change (null if none fits). */
  maxKeepingChangeSat: number | null
}

/**
 * Guard for fixed-amount offboards: round change is a freshly minted vtxo-tree
 * leaf and arkd rejects leaves below dust, so any amount whose change lands in
 * (0, dust) cannot settle. `Ramps.offboard` always spends every VTXO (no coin
 * selection — the SDK throws DustChangeError only after submission), which
 * makes the blocked window a pure function of the round total: gross ∈
 * (total − dust, total). This pre-check explains that at review/confirm time
 * instead of recording a failed row; the SDK error stays the authority for
 * races and config drift (see the DustChangeError mapping in the confirm
 * handler). Input fees are hard-zero by policy (see offboardMaxSat), so the
 * round total needs no per-input deduction.
 */
export function offboardDustChange(
  arkInfo: OperatorInfo,
  buckets: VtxoBuckets,
  recipientSat: number,
): OffboardDustChange | null {
  const dust = Number(arkInfo.dust)
  const changeSat = buckets.roundTotalSat - recipientSat - offboardFeeSat(arkInfo, recipientSat)
  if (changeSat <= 0 || changeSat >= dust) return null
  // Largest recipient keeping a ≥ dust change. The fee depends on the amount,
  // so walk to a fixed point — flat programs converge immediately,
  // proportional ones within the cap; the number is advisory either way.
  let candidate = buckets.roundTotalSat - dust - offboardFeeSat(arkInfo, recipientSat)
  for (let i = 0; i < 4 && candidate > 0; i++) {
    const next = buckets.roundTotalSat - dust - offboardFeeSat(arkInfo, candidate)
    if (next === candidate) break
    candidate = next
  }
  return { changeSat, maxKeepingChangeSat: candidate > 0 ? candidate : null }
}

export interface LnPreview {
  amountSats: number
  description: string
  paymentHash: string
  payee: string | undefined
  /** subdustd's fee rule (percent), as it answered at preview. */
  feePercent: number
  feeSat: number
  /** What leaves the wallet: invoice + fee. subdustd pays the routing itself. */
  totalSat: number
}

/**
 * Pre-send breakdown for a bolt11 invoice: what's billed (invoice amount), the
 * fee and the total that leaves the wallet. Exact, because subdustd's fee is a
 * fixed percentage and it fronts the routing cost (`sendFeeSats` is the formula
 * it charges with). The payee node key isn't in decodeInvoice's shape, so it's
 * pulled best-effort from the raw sections.
 */
export function lightningPreview(invoice: string, feePercent: number): LnPreview {
  const decoded = decodeInvoice(invoice)
  const feeSat = sendFeeSats(decoded.amountSats, feePercent)
  return {
    amountSats: decoded.amountSats,
    description: decoded.description,
    paymentHash: decoded.paymentHash,
    payee: payeeNodeKey(invoice),
    feePercent,
    feeSat,
    totalSat: decoded.amountSats + feeSat,
  }
}

/** subdustd's send fee rule, read before anything is initiated. */
export async function subdustdFeePercent(subdustdUrl: string): Promise<number> {
  const { feePercent } = await getJson<{ feePercent: unknown }>(`${subdustdUrl}/v2/subdust/atomic/send/fees`)
  if (typeof feePercent !== 'number' || !Number.isFinite(feePercent) || feePercent < 0 || feePercent >= 100) {
    throw new Error(`unexpected fee rule ${JSON.stringify(feePercent)}`)
  }
  return feePercent
}

function payeeNodeKey(invoice: string): string | undefined {
  try {
    const sections = decodeBolt11(invoice).sections as Array<{ name: string; value?: unknown }>
    const payee = sections.find((s) => s.name === 'payee_node_key')
    return typeof payee?.value === 'string' ? payee.value : undefined
  } catch {
    return undefined
  }
}
