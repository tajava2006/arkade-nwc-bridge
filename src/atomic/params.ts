import type { AtomicScriptKeys } from './script'

// Swap parameters + direction↔role mapping (ATOMIC_SUBDUST_PLAN.md §3.3).
// One struct drives both directions; only who plays funder/claimer flips.

export enum SwapDirection {
  /** ARK → LN. User pays a sub-dust amount out over Lightning. F=user, C=boltz. */
  Send = 'send',
  /** LN → ARK. User receives a sub-dust amount over Lightning. F=boltz, C=user. */
  Receive = 'receive',
}

/**
 * Resolve the funder/claimer x-only keys for a direction. Send folds the
 * payment from the user (F) to boltz (C); receive folds it from boltz (F) to
 * the user (C). The user is always the bridge-controlled key; boltz is the
 * swap provider's key.
 */
export function rolesForDirection(
  direction: SwapDirection,
  userKey: Uint8Array,
  boltzKey: Uint8Array,
): { funder: Uint8Array; claimer: Uint8Array } {
  return direction === SwapDirection.Send
    ? { funder: userKey, claimer: boltzKey }
    : { funder: boltzKey, claimer: userKey }
}

export interface AtomicSwapParams extends AtomicScriptKeys {
  direction: SwapDirection
  /** a — the sub-dust payment amount in sats (< dust, ≥ vtxoMinAmount). */
  amount: number
  /** H = sha256(preimage), the BOLT11 payment hash (32 bytes). */
  paymentHash: Uint8Array
  /** T — absolute CLTV refund locktime (seconds). */
  refundLocktime: bigint
  /** d — CSV unilateral-exit delay (server's unilateralExitDelay). */
  exitDelay: bigint
  /** V — the funder's regular funding vtxo value in sats (≥ dust, > a). */
  fundingValue: number
  /** Server dust threshold (sats) from arkd getInfo. */
  dust: number
  /** Minimum sub-dust output value (sats) from arkd getInfo (`vtxoMinAmount`). */
  vtxoMin: number
  /** Fee reserved out of the split for the claimer's rail (sats). v1 = 0. */
  feeSats?: number
}

export interface ValidationResult {
  ok: boolean
  error?: string
}

/**
 * Validate that a swap is expressible as an atomic sub-dust split:
 * - a is a genuine sub-dust amount within [vtxoMin, dust) — dust+ amounts use
 *   the regular VHTLC swap, and a < vtxoMin can't become a recoverable vtxo.
 * - the funding vtxo V is regular (≥ dust) and covers a + fee with room, so the
 *   split has a claimer output and (optionally) a funder change output.
 */
export function validateSwapParams(p: AtomicSwapParams): ValidationResult {
  const fee = p.feeSats ?? 0
  if (!Number.isInteger(p.amount) || p.amount <= 0) return fail(`amount must be a positive integer, got ${p.amount}`)
  if (p.amount < p.vtxoMin) return fail(`amount ${p.amount} < vtxoMinAmount ${p.vtxoMin} — can't become a recoverable vtxo`)
  if (p.amount >= p.dust) return fail(`amount ${p.amount} ≥ dust ${p.dust} — use the regular VHTLC swap, not the sub-dust path`)
  if (!Number.isInteger(p.fundingValue) || p.fundingValue < p.dust)
    return fail(`fundingValue ${p.fundingValue} must be a regular vtxo (≥ dust ${p.dust})`)
  if (fee < 0) return fail(`feeSats must be ≥ 0, got ${fee}`)
  if (p.amount + fee > p.fundingValue)
    return fail(`amount ${p.amount} + fee ${fee} exceeds fundingValue ${p.fundingValue}`)
  if (p.paymentHash.length !== 32) return fail(`paymentHash must be 32 bytes, got ${p.paymentHash.length}`)
  if (p.refundLocktime <= 0n) return fail('refundLocktime (T) must be > 0')
  if (p.exitDelay <= 0n) return fail('exitDelay (d) must be > 0')
  for (const [name, key] of [
    ['funder', p.funder],
    ['claimer', p.claimer],
    ['server', p.server],
  ] as const) {
    if (key.length !== 32) return fail(`${name} key must be 32-byte x-only, got ${key.length}`)
  }
  return { ok: true }
}

function fail(error: string): ValidationResult {
  return { ok: false, error }
}
