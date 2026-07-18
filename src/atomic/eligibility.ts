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
 * Pick funding input(s) to spend WHOLE into the shared vtxo — no funding change.
 * The shared value V' then varies (it's the picked total, ≥ V), and the claim
 * split gives the claimer its amount + the funder `V'−…` change (≥ dust ⇒
 * regular by the V bound). This deletes all funding-change handling (the
 * 2026-07-17 false-funding was exactly there) and stops sub-dust from
 * accreting in the funder's wallet.
 *
 *   1. smallest single vtxo that alone covers V = dust + amount → fund it whole;
 *   2. else accumulate ascending until the sum covers V — smallest-first also
 *      consolidates: the claim change comes back as one regular vtxo. (With
 *      amount = a < dust two inputs always suffice; when a fee rides on top,
 *      amount = a + fee can cross dust and need a third — hence the sum check
 *      instead of the old unconditional two-smallest.)
 *
 * `amount` is what the claim must carve out of V beyond the dust buffer (the
 * sub-dust `a`, plus the claimer's feeSats when one is charged) — NOT V itself.
 * Returns [] when the whole eligible pool can't cover V.
 */
export function selectFundingInputs(
  vtxos: VirtualCoin[],
  args: EligibilityArgs & { amount: number },
): VirtualCoin[] {
  const V = args.dust + args.amount
  const eligible = vtxos
    .filter((v) => isEligibleFundingInput(v, args).eligible)
    .sort((a, b) => a.value - b.value)
  const single = eligible.find((v) => v.value >= V)
  if (single) return [single] // smallest vtxo covering V on its own
  const picked: VirtualCoin[] = []
  let sum = 0
  for (const v of eligible) {
    picked.push(v)
    sum += v.value
    if (sum >= V) return picked
  }
  return []
}

function no(reason: string): FundingEligibility {
  return { eligible: false, reason }
}
