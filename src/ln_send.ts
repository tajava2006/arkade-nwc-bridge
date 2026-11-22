import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { RestIndexerProvider, type Wallet } from '@arkade-os/sdk'
import { isSwapError, quoteIdOfSwapId, type Swap } from '@arkade-os/swap'
import { readLockupFate } from '@arkade-os/swap/protocol'
import { hex } from '@scure/base'
import { SqliteAtomicSwapRepository, SwapDirection } from './atomic'
import { atomicSubdustSend } from './atomic/send'
import { decodeInvoice } from './lib/bolt11'
import type { NotifyFn } from './nostr/notifier'
import type { SolverRail } from './solver_rail'

// Below P2TR dust a covenant lockup is itself sub-dust: arkd marks it
// recoverable and refuses the claim, so neither side could ever take it. The
// atomic sub-dust path (subdustd) replaces the lockup with a shared vtxo the
// funder's change keeps above dust.
const DUST_SATS = 330

/** The two Lightning rails. Absent ⇒ the bridge runs Ark-only. */
export interface LightningRails {
  /** Our intent-solver, dust and up. */
  solver: SolverRail
  /** subdustd's API base, sub-dust. */
  subdustdUrl: string
}

export interface LnSendDeps {
  lightning: LightningRails
  wallet: Wallet
  /** ASP (arkd) REST base — the atomic send's server params; a paid send's chain read. */
  arkServerUrl: string
  /** sqlite handle — the atomic send persists its swaps for refund recovery. */
  db: Database
  /**
   * Fired the moment a solver swap exists, so the caller can link its ledger
   * row before the wait. Restart recovery doesn't depend on it — the ledger
   * matches a pending row by payment hash too — it only narrows the match.
   */
  onSwapCreated?: (swapId: string) => void
  notify?: NotifyFn
}

export interface LnSendResult {
  /** sats that left the wallet (invoice + fee) */
  amount: number
  preimage: string
  /** ark txid (the lockup funding, or the sub-dust funding tx) */
  txid: string
  /** the swap behind it (solver `rfq:…`, or the atomic swap id) */
  swapId: string
}

/**
 * A payment the rail cannot call either way yet: the solver may still pay, or
 * the lockup needs recovery. The caller must leave its ledger row pending —
 * marking it failed would release a reservation for money that may have moved.
 */
export class LnSendUnresolved extends Error {}

/** Refused before any value moved (no swap, nothing funded). */
export class LnSendRefused extends Error {
  constructor(
    message: string,
    readonly insufficientFunds = false,
  ) {
    super(message)
  }
}

/**
 * Pay a BOLT11 over Lightning from the Ark wallet — the single LN-send entry
 * point (NWC pay_invoice, dashboard /send). Dust and up: our solver, through
 * the swap client. Below dust: the atomic sub-dust send against subdustd.
 * Atomic either way — the solver claims the lockup only with the preimage
 * (= the invoice paid), else the lockup comes back to us.
 *
 * Any new LN-send entry point MUST come through here: a sub-dust amount on the
 * solver rail would strand on claim.
 */
export async function sendLightning(deps: LnSendDeps, invoice: string): Promise<LnSendResult> {
  let decoded
  try {
    decoded = decodeInvoice(invoice)
  } catch (e) {
    throw new LnSendRefused(`invalid BOLT11 invoice: ${(e as Error).message}`)
  }
  const sats = decoded.amountSats ?? 0
  if (sats <= 0) throw new LnSendRefused('0-amount invoices are not supported')

  if (sats < DUST_SATS) {
    try {
      const r = await atomicSubdustSend(
        {
          wallet: deps.wallet,
          arkServerUrl: deps.arkServerUrl,
          db: deps.db,
          subdustdUrl: deps.lightning.subdustdUrl,
          notify: deps.notify,
        },
        invoice,
        sats,
      )
      return { amount: r.amount, preimage: r.preimage, txid: r.txid, swapId: r.swapId }
    } catch (e) {
      // A throw that leaves the swap ln_inflight means subdustd had the
      // presigs and never answered (a 503/502, a dropped connection): it may
      // still pay. The atomic reconcile resolves it from the swap row.
      const row = new SqliteAtomicSwapRepository(deps.db).getByPaymentHash(decoded.paymentHash)
      if (row?.direction === SwapDirection.Send && row.state === 'ln_inflight') {
        throw new LnSendUnresolved(`sub-dust payment outcome unknown (${(e as Error).message}) — resolving in the background`)
      }
      throw e
    }
  }
  return sendViaSolver(deps, invoice, decoded.paymentHash)
}

/** Outcomes after which the send can be called. */
const PAID = 'paid'
const FAILED = new Set(['refunded', 'failed', 'cancelled'])

async function sendViaSolver(deps: LnSendDeps, invoice: string, paymentHash: string): Promise<LnSendResult> {
  const { client } = deps.lightning.solver
  // Subscribed before pay() so no transition can slip between pay returning
  // and the listener existing; updates for other swaps are ignored.
  let swapId: string | undefined
  const seen: Swap[] = []
  let wake = () => {}
  const unsubscribe = client.onUpdate(({ swap }) => {
    seen.push(swap)
    wake()
  })
  try {
    let res
    try {
      res = await client.pay(invoice)
    } catch (e) {
      if (isSwapError(e)) {
        throw new LnSendRefused(`solver: ${e.message}`, (e as { name?: string }).name === 'InsufficientFunds')
      }
      throw e
    }
    if (res.kind !== 'swap') throw new Error(`a lightning invoice paid as ${res.kind}`)
    swapId = res.swap.id
    deps.onSwapCreated?.(swapId)
    seen.push(res.swap)

    for (;;) {
      const latest = seen.filter((s) => s.id === swapId).at(-1)
      seen.length = 0
      if (latest?.outcome === PAID) {
        return {
          amount: Number(latest.give.amount),
          preimage: await paidPreimage(deps, latest, paymentHash),
          txid: latest.fundingTxid ?? '',
          swapId,
        }
      }
      if (latest && FAILED.has(latest.outcome)) {
        throw new Error(`lightning payment failed (${latest.outcome}${latest.failure ? `: ${latest.failure}` : ''})`)
      }
      if (latest?.outcome === 'needs_recovery') {
        throw new LnSendUnresolved(
          `lightning payment unresolved — the lockup needs recovery${latest.blockedReason ? ` (${latest.blockedReason})` : ''}`,
        )
      }
      await new Promise<void>((r) => (wake = r))
    }
  } finally {
    unsubscribe()
  }
}

const sha256hex = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')

/**
 * The preimage of a paid send. The drive stores the one it verified when it
 * classified the solver's claim (`settlementPreimageHex`); re-checked against
 * the hash here, and read off the chain — the claim's witness, via arkd — if
 * the record somehow lacks it. Never taken on the solver's word.
 */
export async function paidPreimage(
  deps: Pick<LnSendDeps, 'lightning' | 'arkServerUrl'>,
  swap: Swap,
  paymentHash: string,
): Promise<string> {
  const record = (await deps.lightning.solver.repository.getSwapRecord(quoteIdOfSwapId(swap.id))) as
    | { settlementPreimageHex?: string; lockupPkScript?: string }
    | undefined
  const stored = record?.settlementPreimageHex
  if (stored && sha256hex(stored) === paymentHash) return stored
  if (!record?.lockupPkScript) throw new Error(`paid swap ${swap.id} has no lockup script to read the preimage from`)
  const fate = await readLockupFate(new RestIndexerProvider(deps.arkServerUrl), {
    swapPkScript: hex.decode(record.lockupPkScript),
    paymentHash,
  })
  if (fate.fate !== 'claimed') throw new Error(`paid swap ${swap.id}: the lockup reads ${fate.fate}, not claimed`)
  return hex.encode(fate.preimage)
}
