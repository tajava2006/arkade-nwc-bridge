import { createHash, randomBytes } from 'node:crypto'
import { hex } from '@scure/base'
import { DefaultVtxo, getAllNormalizedVtxos } from '@arkade-os/sdk'
import {
  AtomicVtxoScript,
  computeClaimSplit,
  finishCancel,
  finishClaim,
  verifyPresig,
  type AtomicOutput,
  type AtomicPresig,
  type SharedVtxo,
} from '../../src/atomic/index.ts'
import { lnPaymentIsDead } from '../cancel_gate.ts'
import type { SubdustKnobs } from '../config.ts'
import { hrpOf, type ArkSigner } from '../ark/signer.ts'
import type { LndClient } from '../lnd/client.ts'
import type { Logger } from '../log.ts'
import { maxCltvBlocks, sendWindowSecs } from '../send_window.ts'
import { DuplicatePaymentHash, type SwapRow, type SwapStore } from '../store.ts'
import type { ServerSendState } from '../state.ts'
import { badRequest, HttpError, validateArgs, xOnlyHex, type SwapLocks } from './http_error.ts'

// Atomic sub-dust SEND (ARK → LN), server side. We are the CLAIMER and commit
// no capital: the user funds a 4-leaf shared vtxo and hands over two
// presignatures; we verify, pay the invoice, and claim `a` (+ fee) with the
// revealed preimage. Request/response shapes are the Boltz fork's.
//
// Two deliberate departures from the fork:
//  - F25: a thrown sendPayment is "outcome unknown". The row stays ln_inflight
//    and the client gets a 503; resolveInflight decides from LND's own record.
//  - F26: fund, cancel and resolve take a per-swap lock. In the fork a cancel
//    arriving while /send/fund was between its ln_inflight write and
//    sendPayment found no LND record, co-signed the unwind, and the payment
//    then went out with nothing left to claim.

const nowSecs = () => Math.floor(Date.now() / 1000)
const sha256Hex = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const timelockType = (v: bigint): 'seconds' | 'blocks' => (v >= 512n ? 'seconds' : 'blocks')

/** The Boltz routing-fee rule: 0.35% with a 121-sat floor — always the floor at sub-dust. */
export const routingFeeLimitSat = (amountSat: number): number => Math.max(Math.ceil(amountSat * 0.0035), 121)

export const sendFeeSats = (amountSat: number, pct: number): number => (pct > 0 ? Math.ceil((amountSat * pct) / 100) : 0)

const CANCELLABLE: readonly ServerSendState[] = ['init', 'funded', 'ln_inflight', 'failed', 'refund_wait']

export interface SendDeps {
  store: SwapStore
  signer: ArkSigner
  lnd: Pick<LndClient, 'decodeInvoice' | 'getInfo' | 'queryRoutes' | 'sendPayment' | 'trackPayment'>
  knobs: SubdustKnobs
  log: Logger
  locks: SwapLocks
  emit: (swapId: string, state: string) => void
}

export class SendService {
  constructor(private readonly d: SendDeps) {}

  private get windowCfg() {
    const k = this.d.knobs
    return { sendWindow: k.sendWindowSecs, payMargin: k.payMarginSecs, blockTime: k.blockTimeSecs }
  }

  /** Relative cltv of the tightest route to the payee, or undefined — never a gate. */
  private async routeCltvDelta(
    decoded: Awaited<ReturnType<SendDeps['lnd']['decodeInvoice']>>,
    amountSat: number,
  ): Promise<number | undefined> {
    try {
      const [info, routes] = await Promise.all([
        this.d.lnd.getInfo(),
        this.d.lnd.queryRoutes(decoded.destination, Math.max(amountSat, 1), {
          cltvLimit: maxCltvBlocks(this.windowCfg),
          finalCltvDelta: decoded.cltvExpiry,
          routeHints: decoded.routeHints,
        }),
      ])
      if (routes.length === 0) return undefined
      // LND's total_time_lock is an ABSOLUTE height; the pay limit is a delta.
      const lowest = routes.reduce((m, r) => Math.min(m, r.totalTimeLock), Infinity)
      const delta = Math.ceil(lowest - info.blockHeight)
      return Number.isFinite(delta) && delta > 0 ? delta : undefined
    } catch (e) {
      this.d.log.debug(`send: route query failed, using the full window: ${(e as Error).message}`)
      return undefined
    }
  }

  async init(body: unknown) {
    const args = validateArgs(body, [
      { name: 'invoice', type: 'string' },
      { name: 'userPubkey', type: 'string' },
    ])
    const invoice = args.invoice as string
    const userPubkey = xOnlyHex('userPubkey', args.userPubkey)
    const { signer, store, knobs } = this.d

    const decoded = await this.d.lnd.decodeInvoice(invoice).catch((e: Error) => {
      throw badRequest(`invalid invoice: ${e.message}`)
    })
    const a = decoded.valueSat
    const info = await signer.getInfo()
    const dust = Number(info.dust)
    if (a <= 0 || a >= dust) throw badRequest(`amount ${a} is not sub-dust (dust ${dust}) — use a regular swap`)

    // Idempotent init (F17): an unfunded init for this invoice with T still well
    // ahead is handed back as-is, so a client that failed before funding can retry.
    let swap = store.getByPaymentHash(decoded.paymentHash)
    if (swap) {
      if (!(swap.direction === 'send' && swap.state === 'init' && swap.refundLocktime > nowSecs() + knobs.payMarginSecs)) {
        throw badRequest(`invoice already has an atomic swap in progress (${swap.state})`)
      }
    } else {
      const window = sendWindowSecs(await this.routeCltvDelta(decoded, a), this.windowCfg)
      const id = randomBytes(16).toString('hex')
      if (window < knobs.sendWindowSecs) this.d.log.debug(`send ${id}: T sized to ${window}s from the measured route`)
      try {
        swap = store.create({
          id,
          direction: 'send',
          paymentHash: decoded.paymentHash,
          amount: a,
          refundLocktime: nowSecs() + window,
          userPubkey,
          feeSats: sendFeeSats(a, knobs.sendFeePercent),
          selfDelay: info.unilateralExitDelay,
          invoice,
        })
      } catch (e) {
        if (e instanceof DuplicatePaymentHash) throw badRequest(`invoice already has an atomic swap in progress: ${e.message}`)
        throw e
      }
      this.d.emit(swap.id, 'init')
    }

    const delay = swap.selfDelay!.toString()
    return {
      swapId: swap.id,
      boltzPubkey: hex.encode(await signer.xOnlyPublicKey()),
      refundLocktime: swap.refundLocktime,
      exitDelay: delay,
      // Our own script's delay. Equal to exitDelay now that the key is ours
      // alone; kept as its own field because the client reads it.
      boltzScriptDelay: delay,
      feeSats: swap.feeSats,
      dust,
      vtxoMin: Number(info.vtxoMinAmount),
    }
  }

  /** Everything a send's script and split depend on, rebuilt from the row alone. */
  private async context(swap: SwapRow) {
    const { signer } = this.d
    const info = await signer.getInfo()
    const server = await signer.serverXOnly()
    const delay = swap.selfDelay!
    const user = hex.decode(swap.userPubkey)
    const script = new AtomicVtxoScript({
      funder: user,
      claimer: await signer.xOnlyPublicKey(),
      server,
      paymentHash: hex.decode(swap.paymentHash),
      refundLocktime: BigInt(swap.refundLocktime),
      exitDelay: delay,
    })
    const funderAddress = new DefaultVtxo.Script({
      pubKey: user,
      serverPubKey: server,
      csvTimelock: { type: timelockType(delay), value: delay },
    }).address(hrpOf(info), server)
    const claimerAddress = await signer.receiveAddress(delay)
    const split = (fundingValue: number) =>
      computeClaimSplit({
        funderAddress,
        claimerAddress,
        fundingValue,
        amount: swap.amount,
        dust: Number(info.dust),
        feeSats: swap.feeSats,
      })
    return { info, user, script, split, unroll: await signer.serverUnroll() }
  }

  async fund(body: unknown) {
    const args = validateArgs(body, [
      { name: 'swapId', type: 'string' },
      { name: 'presigs', type: 'object' },
      { name: 'fundingOutpoint', type: 'string', optional: true },
    ])
    const swapId = args.swapId as string
    const release = this.d.locks.tryAcquire(swapId)
    if (!release) throw badRequest(`swap ${swapId} is busy (a fund or cancel is in flight)`)
    try {
      return await this.fundLocked(swapId, args.presigs as AtomicPresig, args.fundingOutpoint as string | undefined)
    } finally {
      release()
    }
  }

  private async fundLocked(swapId: string, presig: AtomicPresig, fundingOutpoint: string | undefined) {
    const { store, signer, knobs } = this.d
    const swap = store.get(swapId)
    if (!swap || swap.direction !== 'send') throw badRequest(`unknown send swap ${swapId}`)
    if (swap.state !== 'init') throw badRequest(`swap ${swapId} is ${swap.state}, not fundable`)

    const ctx = await this.context(swap)
    // Verify-before-act: arkd's indexer says where the funding is, not the client.
    const atShared = await getAllNormalizedVtxos(signer.indexer, [hex.encode(ctx.script.pkScript)], { spendableOnly: true })
    const funding = atShared.find((v) =>
      fundingOutpoint !== undefined ? `${v.txid}:${v.vout}` === fundingOutpoint : v.value >= swap.amount,
    )
    if (!funding) throw badRequest(`no funding vtxo at the shared script for swap ${swapId}`)
    const V = funding.value
    if (V < swap.amount + swap.feeSats) throw badRequest(`funding ${V} < amount ${swap.amount} + fee ${swap.feeSats}`)

    const shared: SharedVtxo = { txid: funding.txid, vout: funding.vout, value: V, script: ctx.script }
    const split = ctx.split(V)
    verifyPresig(shared, split.outputs, ctx.unroll, presig, ctx.user)

    // init → funded is the serialization point against a duplicate /send/fund (F3).
    const won = store.transition(swapId, 'init', 'funded', {
      fundingOutpoint: `${funding.txid}:${funding.vout}`,
      fundingValue: V,
      presigs: JSON.stringify(presig),
    })
    if (!won) throw badRequest(`swap ${swapId} is already being funded (concurrent /send/fund) — ignoring duplicate`)
    this.d.emit(swapId, 'funded')

    // Never start a payment that could resolve after T: the funder could refund
    // AND the LN could settle.
    const remaining = swap.refundLocktime - knobs.payMarginSecs - nowSecs()
    if (remaining <= 0) {
      store.transition(swapId, 'funded', 'refund_wait')
      this.d.emit(swapId, 'refund_wait')
      throw badRequest(`too close to T (${remaining}s of margin) — not paying; user refunds after T`)
    }
    const cltvLimit = Math.max(1, Math.floor(remaining / knobs.blockTimeSecs))

    store.transition(swapId, 'funded', 'ln_inflight')
    this.d.emit(swapId, 'ln_inflight')
    let pay: Awaited<ReturnType<SendDeps['lnd']['sendPayment']>>
    try {
      pay = await this.d.lnd.sendPayment(swap.invoice!, { cltvLimit, feeLimitSat: routingFeeLimitSat(swap.amount) })
    } catch (e) {
      this.d.log.warn(`send ${swapId}: LN payment outcome unknown (${(e as Error).message}) — staying ln_inflight`)
      throw new HttpError(503, `LN payment outcome unknown — poll /send/status (${(e as Error).message})`)
    }
    if (pay.status === 'FAILED') {
      store.transition(swapId, 'ln_inflight', 'failed')
      this.d.emit(swapId, 'failed')
      this.d.log.warn(`send ${swapId}: LN pay failed: ${pay.failureReason}`)
      return { status: 'failed', error: pay.failureReason }
    }
    const claimTxid = await this.claim(store.get(swapId)!, shared, split.outputs, ctx.unroll, presig, pay.preimage)
    return { status: 'claimed', preimage: pay.preimage, claimTxid }
  }

  private async claim(
    swap: SwapRow,
    shared: SharedVtxo,
    outputs: AtomicOutput[],
    unroll: Awaited<ReturnType<ArkSigner['serverUnroll']>>,
    presig: AtomicPresig,
    preimage: string,
  ): Promise<string> {
    if (sha256Hex(preimage) !== swap.paymentHash) throw new Error(`send ${swap.id}: LND preimage does not hash to the payment hash`)
    let claimTxid: string
    try {
      claimTxid = await finishClaim(shared, outputs, unroll, presig, this.d.signer.identity, hex.decode(preimage), this.d.signer.ark)
    } catch (e) {
      // Paid but not yet claimed (arkd down, F6): the row stays ln_inflight and
      // resolveInflight retries with the preimage LND keeps.
      throw new HttpError(502, `paid, claim pending (will retry): ${(e as Error).message}`)
    }
    this.d.store.transition(swap.id, 'ln_inflight', 'claimed', { preimage })
    this.d.emit(swap.id, 'claimed')
    this.d.log.info(`send ${swap.id}: claimed ${swap.amount}+${swap.feeSats} sats (arkTx ${claimTxid})`)
    return claimTxid
  }

  /**
   * Settle an ln_inflight send from LND's own record (the resume scan, and the
   * F25 path after a dropped payment stream). A snapshot, never the blocking
   * form, so one long HTLC cannot stall the scan (F13). Skips a swap another
   * call holds — above all a /send/fund that has not reached LND yet, whose
   * NOT_FOUND would otherwise be misread as "never sent".
   */
  async resolveInflight(swapId: string): Promise<ServerSendState | undefined> {
    const release = this.d.locks.tryAcquire(swapId)
    if (!release) return undefined
    try {
      const swap = this.d.store.get(swapId)
      if (!swap || swap.direction !== 'send' || swap.state !== 'ln_inflight') return undefined
      let tracked: Awaited<ReturnType<SendDeps['lnd']['trackPayment']>>
      try {
        tracked = await this.d.lnd.trackPayment(swap.paymentHash)
      } catch {
        return undefined // LND silent — ask again next pass
      }
      // Nothing in LND and nobody holding the lock: the pay never went out (we
      // crashed before it, or LND refused the request). Terminal, safe to cancel.
      if (!tracked.found || tracked.payment.status === 'FAILED') {
        if (tracked.found && tracked.payment.htlcs.some((h) => h.status === 'IN_FLIGHT')) return undefined
        this.d.store.transition(swapId, 'ln_inflight', 'failed')
        this.d.emit(swapId, 'failed')
        return 'failed'
      }
      if (tracked.payment.status !== 'SUCCEEDED') return undefined
      const ctx = await this.context(swap)
      const [txid, vout] = swap.fundingOutpoint!.split(':')
      const shared: SharedVtxo = { txid: txid!, vout: Number(vout), value: swap.fundingValue!, script: ctx.script }
      await this.claim(swap, shared, ctx.split(swap.fundingValue!).outputs, ctx.unroll, JSON.parse(swap.presigs!), tracked.payment.preimage)
      return 'claimed'
    } finally {
      release()
    }
  }

  async cancel(body: unknown) {
    const args = validateArgs(body, [
      { name: 'swapId', type: 'string' },
      { name: 'fundingOutpoint', type: 'string' },
      { name: 'outputs', type: 'object' },
      { name: 'presigs', type: 'object' },
    ])
    const swapId = args.swapId as string
    const outputs = args.outputs as { script: string; amount: number }[]
    if (!Array.isArray(outputs) || outputs.length === 0) throw badRequest('outputs must be a non-empty array')

    const swap = this.d.store.get(swapId)
    if (!swap || swap.direction !== 'send') throw badRequest(`unknown send swap ${swapId}`)
    if (!CANCELLABLE.includes(swap.state as ServerSendState)) {
      return { status: swap.state, error: `swap is ${swap.state} — not cancellable` }
    }
    const release = this.d.locks.tryAcquire(swapId)
    if (!release) return { status: 'refused', error: 'a fund or cancel for this swap is in flight' }
    try {
      const fresh = this.d.store.get(swapId)!
      if (!CANCELLABLE.includes(fresh.state as ServerSendState)) {
        return { status: fresh.state, error: `swap is ${fresh.state} — not cancellable` }
      }
      const verdict = await lnPaymentIsDead(this.d.lnd, fresh.paymentHash)
      if (!verdict.dead) {
        // Not an error: the funder keeps the T refund it already had.
        this.d.log.debug(`send ${swapId}: refusing cooperative cancel — ${verdict.reason}`)
        return { status: 'refused', error: verdict.reason }
      }

      const ctx = await this.context(fresh)
      const [txid, voutStr] = String(args.fundingOutpoint).split(':')
      const vout = Number(voutStr)
      const atShared = await getAllNormalizedVtxos(this.d.signer.indexer, [hex.encode(ctx.script.pkScript)], { spendableOnly: true })
      const funding = atShared.find((v) => v.txid === txid && v.vout === vout)
      if (!funding) throw badRequest(`no spendable funding vtxo at the shared script for swap ${swapId}`)

      // Where the value goes is the funder's call — it is their coin, and our
      // claim right is what is being surrendered. Only pin the total, so
      // nothing is burned or smuggled out in the same tx.
      const outs: AtomicOutput[] = outputs.map((o) => ({ script: hex.decode(o.script), amount: BigInt(o.amount) }))
      const total = outs.reduce((n, o) => n + Number(o.amount), 0)
      if (total !== funding.value) throw badRequest(`cancel outputs sum ${total} != shared value ${funding.value}`)

      const shared: SharedVtxo = { txid: txid!, vout, value: funding.value, script: ctx.script }
      const cancelTxid = await finishCancel(shared, outs, ctx.unroll, args.presigs as AtomicPresig, this.d.signer.identity, this.d.signer.ark)
      this.d.store.transition(swapId, fresh.state, 'cancelled')
      this.d.emit(swapId, 'cancelled')
      this.d.log.info(`send ${swapId}: cooperatively cancelled (arkTx ${cancelTxid}) — ${funding.value} sats back to the funder`)
      return { status: 'cancelled', cancelTxid }
    } finally {
      release()
    }
  }

  status(query: unknown) {
    const { swapId } = validateArgs(query, [{ name: 'swapId', type: 'string' }])
    const swap = this.d.store.get(swapId as string)
    if (!swap) throw badRequest(`unknown swap ${swapId}`)
    return { state: swap.state, preimage: swap.preimage ?? undefined }
  }
}
