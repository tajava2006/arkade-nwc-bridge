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
 * The shared value V' then varies (it's the picked total, ≥ dust + a), and the
 * claim split gives the claimer `a` (sub-dust) + the funder `V'−a` (always ≥
 * dust ⇒ regular). This deletes all funding-change handling (the 2026-07-17
 * false-funding was exactly there) and stops sub-dust dust from accreting in
 * the funder's wallet.
 *
 *   1. smallest single vtxo that alone covers V = dust + a → fund it whole;
 *   2. else the two smallest eligible vtxos — two dust-or-greater vtxos sum to
 *      ≥ 2·dust > dust + a (a < dust), so they always cover V. This also
 *      consolidates: the claim change comes back as one regular vtxo.
 *
 * `amount` is the sub-dust `a`, NOT V (V = dust + a is derived here). Returns []
 * when nothing covers V (operator tops up the mini-wallet).
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
  if (eligible.length >= 2) return [eligible[0]!, eligible[1]!] // two smallest always cover V
  return []
}

function no(reason: string): FundingEligibility {
  return { eligible: false, reason }
}
