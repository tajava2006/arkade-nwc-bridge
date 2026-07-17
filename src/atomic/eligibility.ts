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
 * Pick a funding input that covers the shared output V = dust + a. The funder
 * spends it into V plus change (V's leftover); the funding tx must balance
 * (input == V + change), so a vtxo below V is USELESS — returning one builds an
 * unbalanced tx arkd rejects ("input amount is not equal to output amount",
 * hit live on mainnet 2026-07-17). Preference order among vtxos ≥ V:
 *   1. regular change (value ≥ V + dust) — change is a normal vtxo, one OP_RETURN
 *      in the claim split (§3.5);
 *   2. exact (value == V) — no change output at all;
 *   3. else sub-dust change (V < value < V+dust) — the caller MUST emit that
 *      change as a sub-dust (OP_RETURN) output, not a normal one.
 * Smallest-first within each tier minimizes value tied up in the swap. Returns
 * undefined when nothing covers V (operator tops up the mini-wallet).
 */
export function selectFundingInput(
  vtxos: VirtualCoin[],
  // `amount` is the sub-dust amount `a` — NOT V. The shared output the input
  // must cover is V = dust + a, derived here. (Passing V by mistake inflates
  // every threshold by `dust` — the 2026-07-17 mainnet false-funding.)
  args: EligibilityArgs & { amount: number },
): VirtualCoin | undefined {
  const shared = args.dust + args.amount // V = dust + a — the input must cover this
  const eligible = vtxos
    .filter((v) => isEligibleFundingInput(v, args).eligible && v.value >= shared)
    .sort((a, b) => a.value - b.value)
  if (eligible.length === 0) return undefined
  const regularChange = eligible.filter((v) => v.value >= shared + args.dust)
  if (regularChange.length > 0) return regularChange[0]
  const exact = eligible.filter((v) => v.value === shared)
  if (exact.length > 0) return exact[0]
  return eligible[0] // sub-dust change — caller emits it as an OP_RETURN output
}

function no(reason: string): FundingEligibility {
  return { eligible: false, reason }
}
