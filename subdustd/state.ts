// The SERVER's swap states — the mirror of the bridge's machine in
// src/atomic/state.ts, not a copy of it. Two edges differ on purpose:
//
//  - receive goes funded → settled directly: the user claims (revealing the
//    preimage), we only settle the hold invoice, so there is no server-side
//    `claimed` step.
//  - send `failed` is not terminal here. It means our LN payment terminally
//    failed; the funder's cooperative cancel (F21) is still to come, so
//    failed → cancelled must stay open. Only a returned FAILED leads here —
//    an unknown outcome stays ln_inflight (F25).

export type Direction = 'send' | 'receive'

export const SERVER_SEND_STATES = ['init', 'funded', 'ln_inflight', 'claimed', 'failed', 'refund_wait', 'cancelled'] as const
export const SERVER_RECEIVE_STATES = ['invoice_issued', 'funded', 'settled', 'refund_wait', 'refunded', 'failed'] as const

export type ServerSendState = (typeof SERVER_SEND_STATES)[number]
export type ServerReceiveState = (typeof SERVER_RECEIVE_STATES)[number]
export type ServerState = ServerSendState | ServerReceiveState

const SEND: Record<ServerSendState, readonly ServerSendState[]> = {
  // init → cancelled: the funder may have funded and crashed before /send/fund
  // (F15); the gate still requires the payment to be provably dead.
  init: ['funded', 'cancelled'],
  funded: ['ln_inflight', 'refund_wait', 'cancelled'],
  ln_inflight: ['claimed', 'failed', 'cancelled'],
  failed: ['cancelled'],
  // Past the pay margin we never start paying; the funder refunds after T
  // (unobserved here) or cancels now.
  refund_wait: ['cancelled'],
  claimed: [],
  cancelled: [],
}

const RECEIVE: Record<ServerReceiveState, readonly ServerReceiveState[]> = {
  invoice_issued: ['funded', 'failed'],
  funded: ['settled', 'refund_wait'],
  refund_wait: ['refunded'],
  settled: [],
  refunded: [],
  failed: [],
}

const table = (direction: Direction): Record<string, readonly string[]> => (direction === 'send' ? SEND : RECEIVE)

export const initialState = (direction: Direction): ServerState => (direction === 'send' ? 'init' : 'invoice_issued')

export const isServerState = (direction: Direction, state: string): state is ServerState => state in table(direction)

export const canServerTransition = (direction: Direction, from: string, to: string): boolean => {
  const next = table(direction)[from]
  if (!next) throw new Error(`unknown ${direction} state: ${from}`)
  if (!isServerState(direction, to)) throw new Error(`unknown ${direction} state: ${to}`)
  return next.includes(to)
}

export const isServerTerminal = (direction: Direction, state: string): boolean => {
  const next = table(direction)[state]
  if (!next) throw new Error(`unknown ${direction} state: ${state}`)
  return next.length === 0
}
