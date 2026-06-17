import {
  Estimator,
  isExpired,
  isRecoverable,
  isSpendable,
  isSubdust,
  isVtxoExpiringSoon,
  isValidArkAddress,
  type ArkInfo,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { decodeInvoice } from '@arkade-os/boltz-swap'

// Pure send-side logic shared by the web routes and views: destination → rail
// classification, VTXO bucketing (rail-aware availability), and the
// onchain-output fee preview. The actual rail calls (wallet.sendBitcoin /
// swaps.sendLightningPayment / Ramps.offboard) live in the route handlers —
// see SEND_DESIGN.md for the why behind the three rails.

export type Rail = 'lightning' | 'ark' | 'onchain'

/**
 * Classify a pasted destination. Order matters: bolt11 first (an invoice is
 * unambiguous), then Ark address, else assume onchain — the offboard path
 * validates the onchain address when it decodes it, so we don't re-implement
 * BTC address parsing here just for routing.
 */
export function classifyDestination(raw: string): Rail | null {
  const dest = raw.trim()
  if (!dest) return null
  try {
    const decoded = decodeInvoice(dest)
    if (decoded) return 'lightning'
  } catch {
    // not a bolt11 invoice — fall through
  }
  if (isValidArkAddress(dest)) return 'ark'
  return 'onchain'
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

  for (const v of vtxos) {
    if (!isSpendable(v)) continue
    if (isRecoverable(v) || isExpired(v)) {
      recoverable.push(v)
    } else if (isSubdust(v, dust)) {
      subdust.push(v)
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
export function offboardFeeSat(arkInfo: ArkInfo, amountSat: number): number {
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
export function offboardMaxSat(arkInfo: ArkInfo, buckets: VtxoBuckets): number | null {
  const fee = offboardFeeSat(arkInfo, buckets.roundTotalSat)
  const out = buckets.roundTotalSat - fee
  if (out < Number(arkInfo.dust)) return null
  return out
}
