import { VHTLC, type RelativeTimelock } from '@arkade-os/sdk'
import { SwapDirection } from './params'
import { ripemd160 } from './script'

// Dust+ swaps on the SDK's standard VHTLC (my-server F32_VHTLC_PLAN.md, D12):
// the receiver has a unilateral leaf (preimage + CSV d_c) that matures before
// the sender's (CSV d_s), so a swap pushed on chain still pays the side that
// holds the preimage. Sub-dust stays on the 4-leaf script (script.ts).
//
// Everything here is pure: the timeouts each side proposes and the checks each
// side runs on what the other proposed. Both directions are guarded both ways —
// the user can't cheat subdustd, and subdustd (with the arkd signer, assumed
// colluding) can't cheat the user. The inequalities and their attack names
// (S1–S5 send, R1–R5 receive) are the plan's §5.

/** BIP-68 time-based relative locktimes count in 512-second units. */
export const CSV_UNIT_SECS = 512

export interface VhtlcPolicy {
  /** E — arkd's unilateralExitDelay. Every CSV leaf must be ≥ this or arkd refuses to spend the vtxo at all. */
  exitDelaySecs: number
  /** K — blocks a broadcast transaction may need to confirm, fee bumps included. */
  confirmBlocks: number
  /** N — deepest ancestry (unroll levels) a funding coin may have; deeper coins are refreshed first. */
  maxChainDepth: number
  /** Blocks one unroll level may take (TRUC allows one unconfirmed level per block; ×2 for congestion). */
  unrollBlocksPerLevel: number
  /** D — blocks to notice the other side misbehaving and start the response. */
  detectBlocks: number
  /** Blocks kept between settling an incoming hold HTLC and its expiry. LND cancels it 18 blocks out. */
  settleMarginBlocks: number
  /** Block interval assumed when a block count must not run out before a time lock (blocks arrive fast). */
  fastBlockSecs: number
  /** Block interval assumed when a time lock must cover a block count (blocks arrive slow). */
  slowBlockSecs: number
  /** How far MTP — the clock CLTV/CSV are checked against — trails wall time. */
  mtpLagSecs: number
}

/** Defaults; exitDelaySecs comes from arkd at runtime. V-1 of the plan records why each value. */
export const DEFAULT_VHTLC_POLICY: Omit<VhtlcPolicy, 'exitDelaySecs'> = {
  confirmBlocks: 36,
  maxChainDepth: 20,
  unrollBlocksPerLevel: 2,
  detectBlocks: 1,
  settleMarginBlocks: 24,
  fastBlockSecs: 540,
  slowBlockSecs: 660,
  mtpLagSecs: 3_600,
}

/**
 * The policy for an arkd advertising this unilateralExitDelay on this network.
 * The block-time assumptions are the network's, never the counterparty's word:
 * they are what each side's checks protect its own funds with. Regtest mines
 * on a ~30-second tick with no fee market and 2-hour batches, so it also gets
 * a smaller K and one block per unroll level — mainnet's margins would leave
 * no regtest coin old enough to fund anything.
 */
export const REGTEST_VHTLC_POLICY: Omit<VhtlcPolicy, 'exitDelaySecs'> = {
  ...DEFAULT_VHTLC_POLICY,
  confirmBlocks: 12,
  unrollBlocksPerLevel: 1,
  fastBlockSecs: 20,
  slowBlockSecs: 30,
  mtpLagSecs: 180,
}

export const policyFor = (exitDelaySecs: number, network: string): VhtlcPolicy => ({
  ...(network === 'regtest' ? REGTEST_VHTLC_POLICY : DEFAULT_VHTLC_POLICY),
  exitDelaySecs,
})

/** A VHTLC sits one checkpoint + one ark tx below its deepest funding input. */
export const VHTLC_DEPTH_OVER_INPUTS = 2

/** U — blocks to unroll a VHTLC funded within the depth cap. */
export const unrollBlocks = (p: VhtlcPolicy): number => p.unrollBlocksPerLevel * (p.maxChainDepth + VHTLC_DEPTH_OVER_INPUTS)

export const roundUpCsv = (secs: number): number => Math.ceil(secs / CSV_UNIT_SECS) * CSV_UNIT_SECS
const slow = (p: VhtlcPolicy, blocks: number): number => blocks * p.slowBlockSecs
const fastBlocks = (p: VhtlcPolicy, secs: number): number => Math.ceil(secs / p.fastBlockSecs)

/**
 * Which script a swap rides: the VHTLC needs its own output to be a real coin,
 * so a send uses it when a + fee (the whole VHTLC) reaches dust, a receive when
 * a does. Below that, the 4-leaf script — its theft bound is then < dust.
 */
export function usesVhtlc(direction: SwapDirection, amount: number, feeSats: number, dust: number): boolean {
  return (direction === SwapDirection.Send ? amount + feeSats : amount) >= dust
}

export interface VhtlcTimeouts {
  /** T — absolute CLTV (unix seconds) of refundWithoutReceiver (sender + server). */
  refundLocktime: number
  /** d_c — unilateralClaim (receiver + preimage). */
  claimDelaySecs: number
  /** d_r — unilateralRefund (sender + receiver); no attack runs through it, kept at d_s. */
  refundDelaySecs: number
  /** d_s — unilateralRefundWithoutReceiver (sender alone). */
  refundNoReceiverDelaySecs: number
}

/**
 * Send (sender = user, receiver = subdustd). T = now + window, as today.
 * S1: the user may unroll right after funding and settle the HTLC at its very
 * expiry; subdustd then needs the preimage claim confirmed before the user's
 * own leaf matures — d_s covers the longest HTLC subdustd will route (its
 * cltvLimit never exceeds (window − payMargin) / blockTime) plus K, both at
 * slow blocks, plus MTP lag.
 */
export function sendTimeouts(
  p: VhtlcPolicy,
  a: { nowSecs: number; windowSecs: number; payMarginSecs: number; blockTimeSecs: number },
): VhtlcTimeouts {
  const claim = roundUpCsv(p.exitDelaySecs)
  const maxHtlcBlocks = Math.ceil((a.windowSecs - a.payMarginSecs) / a.blockTimeSecs)
  const noReceiver = roundUpCsv(
    Math.max(slow(p, maxHtlcBlocks + p.confirmBlocks) + p.mtpLagSecs, claim + slow(p, p.confirmBlocks)),
  )
  return {
    refundLocktime: a.nowSecs + a.windowSecs,
    claimDelaySecs: claim,
    refundDelaySecs: noReceiver,
    refundNoReceiverDelaySecs: noReceiver,
  }
}

/**
 * S4: if subdustd stalls and the arkd signer refuses the T refund, the user
 * unrolls — and must finish before the batch expires (until then the operator
 * could sweep it). So a send's funding coins need this much batch life left.
 */
export const sendFundingMinLifeSecs = (p: VhtlcPolicy, windowSecs: number): number =>
  windowSecs + slow(p, unrollBlocks(p) + p.confirmBlocks) + p.mtpLagSecs

/** R1's window: detect, unroll, wait d_c, confirm — all before T. */
const receiveWindowSecs = (p: VhtlcPolicy, claimDelaySecs: number): number =>
  claimDelaySecs + slow(p, p.detectBlocks + unrollBlocks(p) + p.confirmBlocks)

/**
 * Receive (sender = subdustd, receiver = user).
 * R1: subdustd's operator sees the preimage in the user's claim and, after T,
 *   can spend refundWithoutReceiver (subdustd + arkd signer) — even on chain,
 *   with no CSV. So the user's on-chain claim must fit before T.
 * C1/R5: d_s ≥ d_c + K, the user's claim lands before subdustd's own leaf.
 * R4: the user may unroll just before T and claim on chain as late as d_s
 *   after; subdustd's HTLC must still be settleable then (fast blocks).
 */
export function receiveTimeouts(
  p: VhtlcPolicy,
  nowSecs: number,
  /** How long the invoice stays payable. T is fixed at init, so it must still leave R1's window after a late payment. */
  invoiceExpirySecs: number,
): VhtlcTimeouts & { windowSecs: number; finalCltvBlocks: number } {
  const claim = roundUpCsv(p.exitDelaySecs)
  const noReceiver = roundUpCsv(claim + slow(p, p.confirmBlocks))
  const windowSecs = invoiceExpirySecs + receiveWindowSecs(p, claim)
  const finalCltvBlocks =
    fastBlocks(p, windowSecs) + unrollBlocks(p) + fastBlocks(p, noReceiver) + p.confirmBlocks + p.settleMarginBlocks
  return {
    refundLocktime: nowSecs + windowSecs,
    claimDelaySecs: claim,
    refundDelaySecs: noReceiver,
    refundNoReceiverDelaySecs: noReceiver,
    windowSecs,
    finalCltvBlocks,
  }
}

/**
 * R2 from subdustd's side: fund a receive only from coins whose batch outlives
 * T by an unroll — the user may claim (and, censored, unroll) right up to T.
 * The eligibility margin past T.
 */
export const receiveFundingMarginSecs = (p: VhtlcPolicy): number => slow(p, p.detectBlocks + unrollBlocks(p) + p.confirmBlocks)

/** A VHTLC's three CSV delays; with T they rebuild the script. */
export type VhtlcDelays = Omit<OfferedVhtlc, 'refundLocktime'>

/**
 * R1: the latest moment a receive's on-chain claim can start and still confirm
 * before T (detect + unroll + d_c + confirm). Past it with our claim still
 * unaccepted offchain, the claim goes on chain.
 */
export const receiveClaimDeadline = (p: VhtlcPolicy, refundLocktime: number, claimDelaySecs: number): number =>
  refundLocktime - receiveWindowSecs(p, claimDelaySecs)

/** S4/R2: the latest moment an unroll can start and still be on chain before its batch is swept. */
export const unrollDeadline = (p: VhtlcPolicy, batchExpirySecs: number): number =>
  batchExpirySecs - slow(p, p.detectBlocks + unrollBlocks(p) + p.confirmBlocks)

export interface OfferedVhtlc {
  refundLocktime: number
  claimDelaySecs: number
  refundDelaySecs: number
  refundNoReceiverDelaySecs: number
}

const csvProblems = (p: VhtlcPolicy, o: OfferedVhtlc): string[] => {
  const out: string[] = []
  for (const [name, v] of [
    ['claim', o.claimDelaySecs],
    ['refund', o.refundDelaySecs],
    ['refundWithoutReceiver', o.refundNoReceiverDelaySecs],
  ] as const) {
    if (!Number.isInteger(v) || v % CSV_UNIT_SECS !== 0) out.push(`${name} delay ${v}s is not a multiple of ${CSV_UNIT_SECS}s`)
    // arkd refuses to spend a vtxo whose shortest exit leaf is under its delay —
    // the VHTLC would be stuck, and on a receive the claim attempt would still
    // have shown the preimage.
    else if (v < p.exitDelaySecs) out.push(`${name} delay ${v}s is below arkd's exit delay ${p.exitDelaySecs}s`)
  }
  return out
}

/**
 * The user checks subdustd's send terms before funding. Sending, the user is
 * the sender: what can hurt it is being locked out too long (a huge T or d_s)
 * or a VHTLC arkd won't spend. subdustd's own protection (d_s large enough) is
 * subdustd's business. `maxWindowSecs` is what the user will tolerate for T.
 */
export function checkSendOffer(
  p: VhtlcPolicy,
  o: OfferedVhtlc,
  a: { nowSecs: number; maxWindowSecs: number; payMarginSecs: number; blockTimeSecs: number },
): string[] {
  const out = csvProblems(p, o)
  const window = o.refundLocktime - a.nowSecs
  if (window <= 0) out.push(`T ${o.refundLocktime} is not in the future`)
  if (window > a.maxWindowSecs) out.push(`T is ${window}s out, more than the ${a.maxWindowSecs}s the wallet accepts`)
  // The longest d_s the user should accept: what our own policy would set for
  // the longest window we accept, plus a quarter for policy drift between sides.
  const cap = roundUpCsv(1.25 * sendTimeouts(p, { nowSecs: a.nowSecs, windowSecs: a.maxWindowSecs, payMarginSecs: a.payMarginSecs, blockTimeSecs: a.blockTimeSecs }).refundNoReceiverDelaySecs)
  if (o.refundNoReceiverDelaySecs > cap) out.push(`refundWithoutReceiver delay ${o.refundNoReceiverDelaySecs}s exceeds the ${cap}s the wallet accepts`)
  return out
}

/**
 * The user checks a funded receive VHTLC before revealing the preimage — the
 * claim shows it to the arkd operator, who is also subdustd. Refuse unless the
 * on-chain claim can still beat T (R1), the batch can't expire under an unroll
 * (R2), the user's leaf matures first (C1/R5), and the unroll is bounded (U).
 * Refusing costs nothing: no preimage out, the HTLC times out, the payer is refunded.
 */
export function checkReceiveBeforeClaim(
  p: VhtlcPolicy,
  o: OfferedVhtlc,
  a: { nowSecs: number; batchExpirySecs: number; vhtlcDepth: number },
): string[] {
  const out = csvProblems(p, o)
  if (o.refundNoReceiverDelaySecs < o.claimDelaySecs + slow(p, p.confirmBlocks))
    out.push(`refundWithoutReceiver delay ${o.refundNoReceiverDelaySecs}s doesn't clear the claim delay ${o.claimDelaySecs}s by ${p.confirmBlocks} slow blocks`)
  const needT = receiveWindowSecs(p, o.claimDelaySecs)
  if (o.refundLocktime - a.nowSecs < needT)
    out.push(`T is ${o.refundLocktime - a.nowSecs}s away; an on-chain claim needs ${needT}s`)
  const needLife = slow(p, p.detectBlocks + unrollBlocks(p) + p.confirmBlocks)
  if (a.batchExpirySecs - a.nowSecs < needLife)
    out.push(`batch expires in ${a.batchExpirySecs - a.nowSecs}s; an unroll needs ${needLife}s`)
  if (a.vhtlcDepth > p.maxChainDepth + VHTLC_DEPTH_OVER_INPUTS)
    out.push(`VHTLC is ${a.vhtlcDepth} levels deep (cap ${p.maxChainDepth + VHTLC_DEPTH_OVER_INPUTS}) — its unroll isn't bounded`)
  return out
}

/** A funding coin may back a VHTLC: shallow enough that the unroll is bounded. */
export const withinDepthCap = (p: VhtlcPolicy, depth: number): boolean => depth <= p.maxChainDepth

const seconds = (s: number): RelativeTimelock => ({ type: 'seconds', value: BigInt(s) })

/** The VHTLC itself. `paymentHash` is the BOLT11 sha256; the script locks on its ripemd160 (HASH160 of the preimage). */
export function buildVhtlc(a: {
  sender: Uint8Array
  receiver: Uint8Array
  server: Uint8Array
  paymentHash: Uint8Array
  timeouts: OfferedVhtlc
}): VHTLC.Script {
  return new VHTLC.Script({
    sender: a.sender,
    receiver: a.receiver,
    server: a.server,
    preimageHash: ripemd160(a.paymentHash),
    refundLocktime: BigInt(a.timeouts.refundLocktime),
    unilateralClaimDelay: seconds(a.timeouts.claimDelaySecs),
    unilateralRefundDelay: seconds(a.timeouts.refundDelaySecs),
    unilateralRefundWithoutReceiverDelay: seconds(a.timeouts.refundNoReceiverDelaySecs),
  })
}
