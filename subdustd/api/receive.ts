import { createHash, randomBytes } from 'node:crypto'
import { hex } from '@scure/base'
import { DefaultVtxo, getAllNormalizedVtxos, type ArkTxInput } from '@arkade-os/sdk'
import {
  AtomicVtxoScript,
  computeClaimSplit,
  fundShared,
  isEligibleFundingInput,
  presignClaim,
  selectFundingInputs,
  type SharedVtxo,
} from '../../src/atomic/index.ts'
import type { SubdustKnobs } from '../config.ts'
import { hrpOf, type ArkSigner } from '../ark/signer.ts'
import type { LndClient } from '../lnd/client.ts'
import type { Logger } from '../log.ts'
import { DuplicatePaymentHash, type SwapRow, type SwapStore } from '../store.ts'
import { badRequest, HttpError, validateArgs, xOnlyHex, type SwapLocks } from './http_error.ts'

// Atomic sub-dust RECEIVE (LN → ARK), server side. We are the FUNDER: we issue
// a HOLD invoice for the payer, and once their HTLC is held we fund a 4-leaf
// shared vtxo from our own float and presign the claim (a → user, the rest
// back to us). The user claims with the preimage; we settle the hold invoice
// with it. Request/response shapes are the Boltz fork's.
//
// Added over the fork: init refuses when the float cannot fund this amount
// right now, and an accepted HTLC we provably cannot fund is cancelled at once
// — the fork held the payer's HTLC until LND timed it out.

const nowSecs = () => Math.floor(Date.now() / 1000)
const sha256Hex = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const timelockType = (v: bigint): 'seconds' | 'blocks' => (v >= 512n ? 'seconds' : 'blocks')

/**
 * Blocks added to the hold invoice's final CLTV beyond the receive window, so
 * the payer's held HTLC outlives T instead of being cancelled back by LND
 * first — a claim after that would hand us a preimage with nothing to settle
 * (F10). Comfortably past LND's ~10-block pre-timeout cancel-back.
 */
export const RECEIVE_CLTV_BUFFER_BLOCKS = 18

export const receiveFinalCltv = (knobs: Pick<SubdustKnobs, 'receiveWindowSecs' | 'blockTimeSecs'>): number =>
  Math.ceil(knobs.receiveWindowSecs / knobs.blockTimeSecs) + RECEIVE_CLTV_BUFFER_BLOCKS

export interface ReceiveDeps {
  store: SwapStore
  signer: ArkSigner
  lnd: Pick<LndClient, 'addHoldInvoice' | 'lookupInvoice' | 'settleHoldInvoice' | 'cancelHoldInvoice' | 'subscribeSingleInvoice'>
  knobs: SubdustKnobs
  log: Logger
  locks: SwapLocks
  emit: (swapId: string, state: string) => void
}

/** Why the float cannot fund: the two causes need opposite remedies (top up vs. a shorter window). */
class NoFunding extends Error {}

export class ReceiveService {
  private readonly subscriptions = new Map<string, { stop: () => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly d: ReceiveDeps) {}

  close(): void {
    for (const { stop, timer } of this.subscriptions.values()) {
      clearTimeout(timer)
      stop()
    }
    this.subscriptions.clear()
  }

  private async fundingFor(amount: number, refundLocktime: number) {
    const { signer, knobs } = this.d
    const dust = Number((await signer.getInfo()).dust)
    const args = { dust, refundLocktime: BigInt(refundLocktime), marginSecs: knobs.payMarginSecs }
    const own = await signer.ownVtxos()
    const picked = selectFundingInputs(own, { ...args, amount })
    if (picked.length > 0) return picked
    if (own.length === 0) throw new NoFunding('the subdustd float holds no vtxo — top up the address logged at boot')
    const reasons = [...new Set(own.map((v) => isEligibleFundingInput(v, args).reason ?? 'eligible'))]
    throw new NoFunding(
      `the float holds ${own.length} vtxo(s) but none can fund ${amount} sats here (needs > ` +
        `${knobs.receiveWindowSecs + knobs.payMarginSecs}s of batch life left: receive window + pay margin). ` +
        `Per-vtxo: ${reasons.join(' | ')}`,
    )
  }

  async init(body: unknown) {
    const args = validateArgs(body, [
      { name: 'amount', type: 'number' },
      { name: 'paymentHash', type: 'string' },
      { name: 'userPubkey', type: 'string' },
      { name: 'descriptionHash', type: 'string', optional: true },
    ])
    const a = args.amount as number
    const paymentHash = String(args.paymentHash).toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(paymentHash)) throw badRequest('invalid parameter: paymentHash')
    const descriptionHash = args.descriptionHash as string | undefined
    if (descriptionHash !== undefined && !/^[0-9a-fA-F]{64}$/.test(descriptionHash)) throw badRequest('invalid parameter: descriptionHash')
    const userPubkey = xOnlyHex('userPubkey', args.userPubkey)
    const { signer, store, knobs, lnd } = this.d

    const info = await signer.getInfo()
    const dust = Number(info.dust)
    if (!Number.isInteger(a) || a <= 0 || a >= dust) throw badRequest(`amount ${a} is not sub-dust (dust ${dust}) — use a regular swap`)

    // Idempotent init (F17): the same payment hash with its hold invoice still
    // unpaid returns that invoice instead of minting a second one.
    const prior = store.getByPaymentHash(paymentHash)
    if (prior) {
      if (prior.direction === 'receive' && prior.state === 'invoice_issued' && prior.invoice) {
        return { swapId: prior.id, invoice: prior.invoice }
      }
      throw badRequest(`payment hash already has an atomic swap (${prior.state})`)
    }

    const window = knobs.receiveWindowSecs
    const refundLocktime = nowSecs() + window
    try {
      await this.fundingFor(a, refundLocktime)
    } catch (e) {
      if (e instanceof NoFunding) throw new HttpError(503, `cannot fund a receive right now: ${e.message}`)
      throw e
    }

    const invoice = await lnd.addHoldInvoice({
      valueSat: a,
      paymentHash,
      cltvExpiry: receiveFinalCltv(knobs),
      expirySecs: window,
      memo: `subdust-atomic-receive ${a}`,
      descriptionHash,
    })
    const id = randomBytes(16).toString('hex')
    try {
      store.create({
        id,
        direction: 'receive',
        paymentHash,
        amount: a,
        refundLocktime,
        userPubkey,
        selfDelay: info.unilateralExitDelay,
        invoice,
      })
    } catch (e) {
      if (e instanceof DuplicatePaymentHash) throw badRequest(`payment hash already has an atomic swap: ${e.message}`)
      throw e
    }
    this.d.emit(id, 'invoice_issued')
    this.watch(id, paymentHash, window)
    return { swapId: id, invoice }
  }

  /**
   * In-process fast path: fund the moment the payer's HTLC is held. The
   * subscription is dropped once the invoice can no longer be paid so unpaid
   * invoices (common for zaps) do not leak streams (F14); the periodic
   * invoice_issued scan is the durable backstop across restarts.
   */
  private watch(swapId: string, paymentHash: string, windowSecs: number) {
    const stop = this.d.lnd.subscribeSingleInvoice(
      paymentHash,
      (inv) => {
        if (inv.state !== 'ACCEPTED') return
        this.unwatch(swapId)
        this.onHoldAccepted(swapId).catch((e) => this.d.log.error(`receive ${swapId}: funding failed: ${(e as Error).message}`))
      },
      () => this.unwatch(swapId),
    )
    const timer = setTimeout(() => this.unwatch(swapId), (windowSecs + 60) * 1000)
    timer.unref?.()
    this.subscriptions.set(swapId, { stop, timer })
  }

  private unwatch(swapId: string) {
    const sub = this.subscriptions.get(swapId)
    if (!sub) return
    this.subscriptions.delete(swapId)
    clearTimeout(sub.timer)
    sub.stop()
  }

  /** Fund + presign once the payer's HTLC is held. Idempotent: no-op unless still invoice_issued. */
  async onHoldAccepted(swapId: string): Promise<void> {
    const release = this.d.locks.tryAcquire(swapId)
    if (!release) return // the listener and the resume scan both call this (F14)
    try {
      const swap = this.d.store.get(swapId)
      if (!swap || swap.direction !== 'receive' || swap.state !== 'invoice_issued') return
      await this.fundHeld(swap)
    } finally {
      release()
    }
  }

  private async fundHeld(swap: SwapRow): Promise<void> {
    const { signer, store, lnd } = this.d
    const info = await signer.getInfo()
    const server = await signer.serverXOnly()
    const delay = swap.selfDelay!
    const user = hex.decode(swap.userPubkey)
    const script = new AtomicVtxoScript({
      funder: await signer.xOnlyPublicKey(),
      claimer: user,
      server,
      paymentHash: hex.decode(swap.paymentHash),
      refundLocktime: BigInt(swap.refundLocktime),
      exitDelay: delay,
    })
    const unroll = await signer.serverUnroll()

    // Crash window (F15): a funding that landed before we recorded it is adopted,
    // never funded twice. The shared script is unique per swap, so any coin on it is ours.
    const existing = (await getAllNormalizedVtxos(signer.indexer, [hex.encode(script.pkScript)], { spendableOnly: true }))[0]
    let shared: SharedVtxo
    if (existing) {
      shared = { txid: existing.txid, vout: existing.vout, value: existing.value, script }
    } else {
      let funding
      try {
        funding = await this.fundingFor(swap.amount, swap.refundLocktime)
      } catch (e) {
        if (!(e instanceof NoFunding)) throw e
        // Provably unfundable: hand the payer their HTLC back now instead of
        // holding it until LND times it out.
        await lnd.cancelHoldInvoice(swap.paymentHash)
        store.transition(swap.id, 'invoice_issued', 'failed')
        this.d.emit(swap.id, 'failed')
        this.d.log.warn(`receive ${swap.id}: cannot fund, hold invoice cancelled: ${e.message}`)
        return
      }
      const self = await signer.selfScript(delay)
      const inputs: ArkTxInput[] = funding.map((f) => ({
        txid: f.txid,
        vout: f.vout,
        value: f.value,
        tapLeafScript: self.forfeit(),
        tapTree: self.encode(),
      }))
      // Spent WHOLE: the shared value is the picked total; the excess comes back
      // to us as regular change in the claim.
      const value = funding.reduce((n, f) => n + f.value, 0)
      const outpoint = await fundShared(inputs, [{ script: script.pkScript, amount: BigInt(value) }], unroll, signer.identity, signer.ark)
      shared = { txid: outpoint.txid, vout: outpoint.vout, value, script }
    }

    const userAddress = new DefaultVtxo.Script({
      pubKey: user,
      serverPubKey: server,
      csvTimelock: { type: timelockType(delay), value: delay },
    }).address(hrpOf(info), server)
    const split = computeClaimSplit({
      funderAddress: await signer.receiveAddress(delay),
      claimerAddress: userAddress,
      fundingValue: shared.value,
      amount: swap.amount,
      dust: Number(info.dust),
    })
    const presig = await presignClaim(shared, split.outputs, unroll, signer.identity)
    store.transition(swap.id, 'invoice_issued', 'funded', {
      fundingOutpoint: `${shared.txid}:${shared.vout}`,
      fundingValue: shared.value,
      presigs: JSON.stringify(presig),
    })
    // The latency-critical update: the user's claim starts the moment this lands.
    this.d.emit(swap.id, 'funded')
    this.d.log.info(`receive ${swap.id}: funded ${shared.txid}:${shared.vout} (${shared.value} sats) + presigned`)
  }

  /**
   * A receive still invoice_issued (the listener is in-memory, so a restart or
   * a failed funding leaves a held invoice with nothing behind it — F14):
   * ACCEPTED → fund now, CANCELED → the payer was refunded, terminal.
   */
  async resumeInvoiceIssued(swapId: string): Promise<void> {
    const swap = this.d.store.get(swapId)
    if (!swap || swap.direction !== 'receive' || swap.state !== 'invoice_issued') return
    let state: string
    try {
      state = (await this.d.lnd.lookupInvoice(swap.paymentHash)).state
    } catch {
      return // LND silent — next pass
    }
    if (state === 'ACCEPTED') {
      await this.onHoldAccepted(swapId)
    } else if (state === 'CANCELED') {
      const release = this.d.locks.tryAcquire(swapId)
      if (!release) return
      try {
        if (this.d.store.transition(swapId, 'invoice_issued', 'failed')) {
          this.d.emit(swapId, 'failed')
          this.d.log.info(`receive ${swapId}: hold invoice cancelled or expired before funding → failed`)
        }
      } finally {
        release()
      }
    }
  }

  status(query: unknown) {
    const { swapId } = validateArgs(query, [{ name: 'swapId', type: 'string' }])
    const swap = this.d.store.get(swapId as string)
    if (!swap || swap.direction !== 'receive') throw badRequest(`unknown receive swap ${swapId}`)
    return this.statusOf(swap)
  }

  private async statusOf(swap: SwapRow) {
    const delay = swap.selfDelay!.toString()
    return {
      state: swap.state,
      fundingOutpoint: swap.fundingOutpoint ?? undefined,
      presigs: swap.presigs ? JSON.parse(swap.presigs) : undefined,
      boltzPubkey: hex.encode(await this.d.signer.xOnlyPublicKey()),
      refundLocktime: swap.refundLocktime,
      exitDelay: delay,
      // Our change output in the presigned claim uses this; equal to exitDelay
      // now that the key is ours alone.
      boltzScriptDelay: delay,
    }
  }

  /**
   * The receiver reveals the preimage so we settle the hold invoice (the claim
   * tx carries it too; the scan harvests it if this never comes — F1).
   * Idempotent: an already-settled swap answers settled (F12).
   */
  async settle(body: unknown) {
    const args = validateArgs(body, [
      { name: 'swapId', type: 'string' },
      { name: 'preimage', type: 'string' },
    ])
    const swapId = args.swapId as string
    const preimage = String(args.preimage).toLowerCase()
    const swap = this.d.store.get(swapId)
    if (!swap || swap.direction !== 'receive') throw badRequest(`unknown receive swap ${swapId}`)
    if (swap.state === 'settled') return { settled: true }
    if (!/^[0-9a-f]{64}$/.test(preimage) || sha256Hex(preimage) !== swap.paymentHash) {
      throw badRequest('preimage does not match the invoice payment hash')
    }
    const release = this.d.locks.tryAcquire(swapId)
    if (!release) throw new HttpError(503, `swap ${swapId} is busy — retry`)
    try {
      await this.settleWith(swapId, preimage)
      return { settled: true }
    } finally {
      release()
    }
  }

  /** Shared by /receive/settle and the preimage harvester; caller holds the lock. */
  async settleWith(swapId: string, preimage: string): Promise<void> {
    const swap = this.d.store.get(swapId)!
    if (swap.state === 'settled') return
    if (swap.state !== 'funded') throw badRequest(`swap ${swapId} is ${swap.state}, not settleable`)
    try {
      await this.d.lnd.settleHoldInvoice(preimage)
    } catch (e) {
      // A settle that raced another one (or a retry after a lost reply) finds
      // the invoice already settled — that is success, not an error.
      const inv = await this.d.lnd.lookupInvoice(swap.paymentHash).catch(() => undefined)
      if (inv?.state !== 'SETTLED') throw e
    }
    this.d.store.transition(swapId, 'funded', 'settled', { preimage })
    this.d.emit(swapId, 'settled')
    this.d.log.info(`receive ${swapId}: settled the hold invoice (${swap.amount} sats)`)
  }
}
