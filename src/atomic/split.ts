import type { ArkAddress } from '@arkade-os/sdk'

// Claim-split calculator (ATOMIC_SUBDUST_PLAN.md §3.2). The claim arkTx pays the
// claimer its amount a (always a sub-dust OP_RETURN vtxo — recoverable) and
// returns the funder's change. Outputs must sum to the funding value V (arkd
// enforces inputAmount == outputAmount; the P2A anchor is value 0 and is added
// by the tx builder in #05, not here).

/** A virtual-tx output: raw scriptPubKey + amount. Structurally compatible with
 *  @scure/btc-signer's TransactionOutput, kept local so #04 stays tx-agnostic. */
export interface AtomicOutput {
  script: Uint8Array
  amount: bigint
}

/** arkd's OP_RETURN output cap, measured in spike #01 (§2.4): 2. Our split has
 *  at most 2 (a + a sub-dust change), so it always fits — but guard the edge. */
export const MAX_OP_RETURN_OUTPUTS = 2

export type ChangeKind = 'regular' | 'subdust' | 'omitted'

export interface ClaimSplit {
  /** claimer(a) first, then optional fee, then optional funder change. */
  outputs: AtomicOutput[]
  /** Count of sub-dust OP_RETURN outputs (for the maxOpReturnOutputs guard). */
  opReturns: number
  claimerAmount: bigint
  feeAmount: bigint
  changeAmount: bigint
  changeKind: ChangeKind
}

export class SubdustEdgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubdustEdgeError'
  }
}

export interface ClaimSplitArgs {
  funderAddress: ArkAddress
  claimerAddress: ArkAddress
  /** V — funding vtxo value (sats). */
  fundingValue: number
  /** a — sub-dust payment amount (sats). */
  amount: number
  /** Server dust threshold (sats). */
  dust: number
  /** Fee reserved for the claimer's rail (sats). v1 = 0. */
  feeSats?: number
  /** Where the fee goes when feeSats > 0 (required in that case). */
  feeRecipient?: ArkAddress
  /** Override the OP_RETURN cap (default MAX_OP_RETURN_OUTPUTS). */
  maxOpReturnOutputs?: number
}

// A sub-dust amount goes to the OP_RETURN pkScript (recoverable vtxo); a
// dust-or-greater amount goes to the regular P2TR pkScript.
function outputFor(address: ArkAddress, amount: number, dust: number): { output: AtomicOutput; isOpReturn: boolean } {
  const isOpReturn = amount < dust
  return {
    output: { script: isOpReturn ? address.subdustPkScript : address.pkScript, amount: BigInt(amount) },
    isOpReturn,
  }
}

/**
 * Compute the claim split. The claimer's a is always sub-dust (OP_RETURN); the
 * funder's change V−a−fee is regular (≥ dust), sub-dust (OP_RETURN), or omitted
 * (0) — the three-way branch. Throws {@link SubdustEdgeError} if the split would
 * need more OP_RETURN outputs than the server allows (the U−a<dust edge, §2.4).
 */
export function computeClaimSplit(args: ClaimSplitArgs): ClaimSplit {
  const { funderAddress, claimerAddress, fundingValue: V, amount: a, dust } = args
  const fee = args.feeSats ?? 0
  const maxOpReturn = args.maxOpReturnOutputs ?? MAX_OP_RETURN_OUTPUTS

  if (a <= 0) throw new SubdustEdgeError(`amount must be positive, got ${a}`)
  if (a >= dust) throw new SubdustEdgeError(`amount ${a} ≥ dust ${dust} is not a sub-dust split`)
  if (fee < 0) throw new SubdustEdgeError(`fee must be ≥ 0, got ${fee}`)
  const change = V - a - fee
  if (change < 0) throw new SubdustEdgeError(`amount ${a} + fee ${fee} exceeds funding value ${V}`)

  const outputs: AtomicOutput[] = []
  let opReturns = 0

  // claimer's a — always sub-dust.
  const claimer = outputFor(claimerAddress, a, dust)
  outputs.push(claimer.output)
  if (claimer.isOpReturn) opReturns++

  // fee — optional; needs an explicit recipient so outputs still sum to V.
  if (fee > 0) {
    if (!args.feeRecipient) throw new SubdustEdgeError('feeSats > 0 requires a feeRecipient')
    const feeOut = outputFor(args.feeRecipient, fee, dust)
    outputs.push(feeOut.output)
    if (feeOut.isOpReturn) opReturns++
  }

  // funder change — regular / sub-dust / omitted.
  let changeKind: ChangeKind = 'omitted'
  if (change > 0) {
    const changeOut = outputFor(funderAddress, change, dust)
    outputs.push(changeOut.output)
    changeKind = changeOut.isOpReturn ? 'subdust' : 'regular'
    if (changeOut.isOpReturn) opReturns++
  }

  if (opReturns > maxOpReturn) {
    throw new SubdustEdgeError(
      `split needs ${opReturns} OP_RETURN outputs > server max ${maxOpReturn} — reject this shape (SUBDUST_EDGE_REJECTED)`,
    )
  }

  return {
    outputs,
    opReturns,
    claimerAmount: BigInt(a),
    feeAmount: BigInt(fee),
    changeAmount: BigInt(change),
    changeKind,
  }
}
