import { SwapDirection } from './params'

// Bridge-side swap state machine (ATOMIC_SUBDUST_PLAN.md §3.4). The bridge is F
// on send (funds + presigns, refunds after T) and C on receive (holds the
// preimage, claims, drives settle). These are the bridge's own states; boltz
// runs its mirror on pg (#08/#09). Pure logic — no DB, no network.

export const SEND_STATES = [
  'init', // swap row created, nothing funded yet
  'funded', // shared vtxo funded + presig handed to boltz
  'ln_inflight', // boltz verified + is paying the LN invoice
  'claimed', // boltz claimed a (LN settled) — terminal success
  'refund_wait', // LN failed/timed out; waiting for T to refund
  'refunded', // F reclaimed the full V after T — terminal
  'cancelled', // cooperative F+C+server unwind — terminal
  'failed', // terminal error
] as const

export const RECEIVE_STATES = [
  'init', // preimage generated, nothing issued yet
  'invoice_issued', // hold invoice handed to the external payer
  'funded', // boltz funded the shared vtxo + presig; bridge verified it
  'claimed', // bridge revealed the preimage in the claim
  'settled', // boltz settled the hold invoice — terminal success
  'refund_wait', // unclaimed/expired; boltz will refund the payer
  'refunded', // boltz refunded (payer made whole) — terminal
  'failed', // terminal error
] as const

export type SendState = (typeof SEND_STATES)[number]
export type ReceiveState = (typeof RECEIVE_STATES)[number]
export type AtomicSwapState = SendState | ReceiveState

const SEND_TRANSITIONS: Record<SendState, readonly SendState[]> = {
  init: ['funded', 'cancelled', 'failed'],
  funded: ['ln_inflight', 'refund_wait', 'cancelled', 'failed'],
  ln_inflight: ['claimed', 'refund_wait', 'failed'],
  refund_wait: ['refunded', 'failed'],
  claimed: [],
  refunded: [],
  cancelled: [],
  failed: [],
}

const RECEIVE_TRANSITIONS: Record<ReceiveState, readonly ReceiveState[]> = {
  init: ['invoice_issued', 'failed'],
  invoice_issued: ['funded', 'refund_wait', 'failed'],
  funded: ['claimed', 'refund_wait', 'failed'],
  claimed: ['settled', 'failed'],
  refund_wait: ['refunded', 'failed'],
  settled: [],
  refunded: [],
  failed: [],
}

function transitions(direction: SwapDirection): Record<string, readonly string[]> {
  return direction === SwapDirection.Send ? SEND_TRANSITIONS : RECEIVE_TRANSITIONS
}

/** Terminal states carry no outgoing transitions. */
export function isTerminal(direction: SwapDirection, state: AtomicSwapState): boolean {
  const t = transitions(direction)[state]
  if (!t) throw new Error(`unknown ${direction} state: ${state}`)
  return t.length === 0
}

/** Whether `from → to` is a legal transition for the direction. */
export function canTransition(direction: SwapDirection, from: AtomicSwapState, to: AtomicSwapState): boolean {
  const next = transitions(direction)[from]
  if (!next) throw new Error(`unknown ${direction} state: ${from}`)
  return next.includes(to)
}

/** Assert a transition is legal, else throw with the offending pair. */
export function assertTransition(direction: SwapDirection, from: AtomicSwapState, to: AtomicSwapState): void {
  if (!canTransition(direction, from, to)) {
    throw new Error(`illegal ${direction} transition: ${from} → ${to}`)
  }
}

// ── boot resume (ATOMIC_SUBDUST_PLAN.md §3.4 "부팅 재개") ──────────────────────
// On boot the bridge resumes each non-terminal swap. Send: refund after T,
// otherwise keep polling boltz. Receive: retry the claim, then the settle call;
// wait out boltz's refund on the miss path.
export type ResumeAction =
  | 'none' // terminal — nothing to do
  | 'poll' // keep watching the counterparty for the next transition
  | 'refund' // send: T elapsed → run the refund executor now
  | 'wait_refund' // send: refund_wait but T not yet reached
  | 'retry_claim' // receive: funded but not yet claimed → re-attempt the claim
  | 'retry_settle' // receive: claimed but settle call unconfirmed → re-send it
  | 'wait_settle' // receive: refund_wait → boltz refunds the payer, just observe

export interface ResumeInput {
  direction: SwapDirection
  state: AtomicSwapState
  /** T — absolute refund locktime (seconds). */
  refundLocktime: bigint
  /** Current time (seconds). */
  nowSecs: bigint
}

export function classifyResume(input: ResumeInput): ResumeAction {
  const { direction, state, refundLocktime, nowSecs } = input
  if (isTerminal(direction, state)) return 'none'
  const tElapsed = nowSecs >= refundLocktime

  if (direction === SwapDirection.Send) {
    switch (state as SendState) {
      case 'refund_wait':
        return tElapsed ? 'refund' : 'wait_refund'
      case 'funded':
      case 'ln_inflight':
        // If T has already passed with no claim, reclaim; else keep watching.
        return tElapsed ? 'refund' : 'poll'
      default:
        return 'poll'
    }
  }

  switch (state as ReceiveState) {
    case 'funded':
      return 'retry_claim'
    case 'claimed':
      return 'retry_settle'
    case 'refund_wait':
      return 'wait_settle'
    default:
      return 'poll'
  }
}
