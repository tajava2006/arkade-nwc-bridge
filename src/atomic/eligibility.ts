import { isRecoverable, isSpendable, type VirtualCoin } from '@arkade-os/sdk'

// Funding-input eligibility (ATOMIC_SUBDUST_PLAN.md §3.5). The funder spends one
// regular vtxo into the shared 4-leaf output. It must be:
//   - regular (≥ dust) — arkd rejects sub-dust/swept vtxos as inputs
//     (VTXO_RECOVERABLE, §2.3), so a recoverable coin can't fund.
//   - spendable and not recoverable/swept.
//   - long-lived enough that the derived shared vtxo survives the whole swap:
//     its batch expiry must outlast the refund deadline T by a margin. An input
//     whose batch expires before T lets arkd sweep the shared vtxo mid-swap.

export interface FundingEligibility {
  eligible: boolean
  reason?: string
}

export interface EligibilityArgs {
  /** Server dust threshold (sats). */
  dust: number
  /** T — absolute CLTV refund locktime (seconds). */
  refundLocktime: bigint
  /** Safety margin (seconds) the batch expiry must clear T by. */
  marginSecs: number
}

// batchExpiry is milliseconds in the wallet model but the raw indexer can hand
// back seconds; normalize by magnitude (a unix ms timestamp is ~1e12+).
function batchExpirySecs(vtxo: VirtualCoin): number | undefined {
  const raw = vtxo.virtualStatus.batchExpiry
  if (raw === undefined) return undefined
  return raw > 1e12 ? Math.floor(raw / 1000) : raw
}

export function isEligibleFundingInput(vtxo: VirtualCoin, args: EligibilityArgs): FundingEligibility {
  if (!isSpendable(vtxo)) return no('not spendable (spent/pending)')
  if (isRecoverable(vtxo)) return no('recoverable (swept) — arkd rejects it as an input')
  if (vtxo.value < args.dust) return no(`sub-dust value ${vtxo.value} < dust ${args.dust}`)

  const expiry = batchExpirySecs(vtxo)
  if (expiry === undefined) return no('no batchExpiry — cannot verify it outlasts the refund deadline')
  const floor = Number(args.refundLocktime) + args.marginSecs
  if (expiry <= floor) return no(`batch expires ${expiry} ≤ T+margin ${floor} — shared vtxo could be swept mid-swap`)

  return { eligible: true }
}

/**
 * Pick a funding input. Prefers a vtxo of value ≥ dust + a so the funder's
 * change is a regular vtxo (keeps the split to a single OP_RETURN, §3.5);
 * otherwise returns the first eligible vtxo. Returns undefined if none qualify.
 */
export function selectFundingInput(
  vtxos: VirtualCoin[],
  args: EligibilityArgs & { amount: number },
): VirtualCoin | undefined {
  const eligible = vtxos.filter((v) => isEligibleFundingInput(v, args).eligible)
  if (eligible.length === 0) return undefined
  const changeRegular = args.dust + args.amount
  // smallest vtxo that still yields a regular change, else the smallest eligible
  // (minimize the value tied up in the swap).
  const preferred = eligible.filter((v) => v.value >= changeRegular).sort((a, b) => a.value - b.value)
  if (preferred.length > 0) return preferred[0]
  return [...eligible].sort((a, b) => a.value - b.value)[0]
}

function no(reason: string): FundingEligibility {
  return { eligible: false, reason }
}
