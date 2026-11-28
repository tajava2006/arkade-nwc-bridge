import { createHash } from 'node:crypto'
import { hex } from '@scure/base'
import { OnchainWallet, Unroll, timelockToSequence, type NetworkName, type OnchainProvider, type VirtualCoin } from '@arkade-os/sdk'
import { buildVhtlc, roleLeaves, signLeafSpendAtRate } from '../src/atomic/index.ts'
import { findSpender } from '../src/chain/spender.ts'
import { timelockType } from '../src/atomic/ark_util.ts'
import type { ArkSigner } from './ark/signer.ts'
import type { SwapLocks } from './api/http_error.ts'
import type { ReceiveService } from './api/receive.ts'
import type { LndClient } from './lnd/client.ts'
import type { Logger } from './log.ts'
import type { OnchainProgress, SwapRow, SwapStore } from './store.ts'

// The VHTLC's on-chain paths, enforced (F32_VHTLC_PLAN.md §7). Nobody upstream
// does this — Boltz, fulmine and the SDK all stop at the script (§V-1 survey).
//
// When an unroll reaches one of our VHTLCs (the counterparty started it, or
// arkd is gone), the offchain paths are dead: arkd won't co-sign an unrolled
// vtxo. From then on this executor owns the swap:
//   - push the rest of the unroll (Unroll.Session, CPFP from our fuel address);
//   - send (we are the receiver): with the preimage LND returned for the
//     payment we made, spend unilateralClaim once d_c has passed — d_s was
//     sized so that lands before the user's own leaf (vhtlc.ts S1);
//   - receive (we are the sender): watch the output; a claim carries the
//     user's preimage in its witness → settle the hold invoice with it. Nothing
//     by d_s → spend unilateralRefundWithoutReceiver and release the payer.
// Restart-safe: the progress lives on the row (store v3 `onchain`), the session
// skips what's already on chain, and a spend already made is found, not repeated.

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
/** The swap preimage, if this witness carries it (only the claim leaf's does). */
const revealedPreimage = (witness: Uint8Array[], paymentHash: string): Uint8Array | undefined =>
  witness.find((w) => w.length === 32 && sha256Hex(w) === paymentHash)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A leaf spend still unconfirmed after this many blocks is re-broadcast at a higher rate. */
const REBUMP_AFTER_BLOCKS = 6
const MIN_FEE_RATE = 2
/** How often arkd is asked for our unrolled coins outside an unroll we saw (a full-history read). */
const OWN_UNROLLED_QUERY_MS = 600_000

export interface OnchainDeps {
  store: SwapStore
  signer: ArkSigner
  provider: OnchainProvider
  network: NetworkName
  lnd: Pick<LndClient, 'trackPayment'>
  receive: Pick<ReceiveService, 'settleWith' | 'resumeRefundWait'>
  locks: SwapLocks
  log: Logger
  emit: (swapId: string, state: string) => void
  /** How often a driven swap re-checks the chain. */
  pollMs?: number
}

export class OnchainExecutor {
  private fuelWallet?: Promise<OnchainWallet>
  private readonly driving = new Set<string>()
  private stopped = false
  /** Own coins an unroll dragged on chain that are dealt with (swept, or not worth it). */
  private ownDone = new Set<string>()
  /** Found but not swept yet (maturing) — rechecked every pass without asking arkd again. */
  private ownPending: VirtualCoin[] = []
  private ownQueriedAt = 0
  /** Set when we see an unroll: that is when our change gets dragged out. */
  private ownDirty = true
  private sweepingOwn = false

  constructor(private readonly d: OnchainDeps) {}

  /** Our CPFP fuel and the destination of what we take on chain: a P2TR of the subdustd key. */
  fuel(): Promise<OnchainWallet> {
    this.fuelWallet ??= OnchainWallet.create(this.d.signer.identity, this.d.network, this.d.provider)
    return this.fuelWallet
  }

  stop(): void {
    this.stopped = true
  }

  /** One pass: hand every VHTLC swap an unroll has reached to drive(), one task per swap. */
  async scan(): Promise<void> {
    if (!this.sweepingOwn && !this.stopped) {
      this.sweepingOwn = true
      void this.sweepOwnUnrolled()
        .catch((e) => this.d.log.warn(`onchain: sweeping our unrolled coins failed — ${(e as Error).message}; next pass`))
        .finally(() => (this.sweepingOwn = false))
    }
    const { store } = this.d
    const rows = [...store.list('send', ['ln_inflight']), ...store.list('receive', ['funded'])].filter(
      (r) => r.vhtlc && r.fundingOutpoint && r.onchain?.stage !== 'abandoned' && r.onchain?.stage !== 'done',
    )
    for (const row of rows) {
      if (this.driving.has(row.id) || this.stopped) continue
      if (!row.onchain && !(await this.unrolled(row))) continue
      this.driving.add(row.id)
      void this.drive(row.id)
        .catch((e) => this.d.log.error(`onchain ${row.id}: ${(e as Error).message} — retrying next pass`))
        .finally(() => this.driving.delete(row.id))
    }
  }

  /**
   * Has an unroll reached this VHTLC? arkd flags it once it notices; the chain
   * says so first: an Ark tx is never on chain unless someone unrolled it, so
   * the VHTLC's own txid showing up (mempool or block) is the earliest sign —
   * and the only one if arkd is gone.
   */
  private async unrolled(row: SwapRow): Promise<boolean> {
    const [txid, vout] = row.fundingOutpoint!.split(':')
    const onChain = await this.d.provider.getTxStatus(txid!).then(
      () => true,
      () => false,
    )
    if (onChain) return true
    const { vtxos } = await this.d.signer.indexer.getVtxos({ outpoints: [{ txid: txid!, vout: Number(vout) }] }).catch(() => ({ vtxos: [] as { isUnrolled?: boolean }[] }))
    return vtxos.some((v) => v.isUnrolled)
  }

  private progress(row: SwapRow, p: Partial<OnchainProgress>): OnchainProgress {
    const next = { ...(row.onchain ?? { stage: 'unrolling' }), ...p } as OnchainProgress
    this.d.store.setOnchain(row.id, next)
    row.onchain = next
    return next
  }

  private async drive(id: string): Promise<void> {
    const { store, signer, provider, log } = this.d
    let row = store.get(id)!
    const [txid, voutStr] = row.fundingOutpoint!.split(':')
    const outpoint = { txid: txid!, vout: Number(voutStr) }
    if (!row.onchain) {
      this.ownDirty = true // the Ark tx's other outputs — our change among them — came on chain too
      log.warn(`onchain ${id}: the VHTLC ${row.fundingOutpoint} was unrolled — taking the swap on chain (${row.direction})`)
      this.progress(row, { stage: 'unrolling' })
    }

    // A send's claim needs the preimage; without a paid invoice there is nothing of ours.
    let preimage: Uint8Array | undefined
    if (row.direction === 'send') {
      const tracked = await this.d.lnd.trackPayment(row.paymentHash)
      if (tracked.found && tracked.payment.status === 'SUCCEEDED') {
        preimage = hex.decode(tracked.payment.preimage)
      } else if (!tracked.found || tracked.payment.status === 'FAILED') {
        this.progress(row, { stage: 'abandoned', reason: 'payment not made — the VHTLC is the funder’s to refund' })
        log.info(`onchain ${id}: unrolled send we never paid — the funder refunds; nothing of ours`)
        return
      } else {
        return // HTLC in flight: decide once it resolves (next pass)
      }
    }

    // 1. the VHTLC output itself on chain
    if (row.onchain!.stage === 'unrolling') {
      const session = await Unroll.Session.create(outpoint, await this.fuel(), provider, signer.indexer)
      for await (const step of session) {
        if (step.type === Unroll.StepType.UNROLL) log.info(`onchain ${id}: broadcast ${step.tx.id}`)
        if (this.stopped) return
      }
      const status = await provider.getTxStatus(outpoint.txid)
      if (!status.confirmed) throw new Error('unroll finished but the VHTLC tx is unconfirmed')
      this.progress(row, { stage: 'csv_wait', height: status.blockHeight })
      log.info(`onchain ${id}: VHTLC output confirmed at ${status.blockHeight}`)
    }

    const script = await this.scriptFor(row)
    const leaves = roleLeaves(script)
    const isSend = row.direction === 'send'
    const delay = isSend ? row.vhtlc!.claimDelaySecs : row.vhtlc!.refundNoReceiverDelaySecs
    const leaf = isSend ? leaves.uclaim! : leaves.uexit
    const fuel = await this.fuel()

    while (!this.stopped) {
      row = store.get(id)!
      const spent = await findSpender(provider, outpoint.txid, outpoint.vout, row.onchain!.height!)
      let contested = false
      if (spent) {
        const revealed = revealedPreimage(spent.witness, row.paymentHash)
        // A receive's preimage is all we need from their claim — settle at once,
        // confirmed or not. Anything else counts only once it is buried: a
        // mempool spend can still be replaced, and releasing the payer on our
        // own unconfirmed refund would lose to a claim that replaces it.
        if (!isSend && revealed) return this.settleSpent(row, spent.txid, spent.witness)
        if ((await provider.getTxStatus(spent.txid)).confirmed) return this.settleSpent(row, spent.txid, spent.witness)
        const ours = isSend ? !!revealed : !revealed
        // theirs, still in the mempool (a send's funder racing our claim): outbid it now
        contested = !ours
      }

      if (await this.csvElapsed(row.onchain!.height!, delay)) {
        const tip = await provider.getChainTip()
        const stale = row.onchain!.spendTxid && tip.height - (row.onchain!.broadcastHeight ?? tip.height) >= REBUMP_AFTER_BLOCKS
        if (!row.onchain!.spendTxid || stale || contested) {
          const est = (await provider.getFeeRate().catch(() => undefined)) ?? MIN_FEE_RATE
          const feeRate = Math.max(MIN_FEE_RATE, est, stale || contested ? Math.ceil((row.onchain!.feeRate ?? est) * 1.5) + 1 : 0)
          const tx = await signLeafSpendAtRate(
            {
              ...outpoint,
              value: row.fundingValue!,
              pkScript: script.pkScript,
              leaf,
              sequence: timelockToSequence({ type: 'seconds', value: BigInt(delay) }),
              preimage,
              destination: fuel.onchainP2TR.script,
            },
            feeRate,
            signer.identity,
          )
          try {
            await provider.broadcastTransaction(tx.hex)
            this.progress(row, { stage: 'spending', spendTxid: tx.id, feeRate, broadcastHeight: tip.height })
            log.info(`onchain ${id}: ${isSend ? 'claim' : 'refund'} ${tx.id} broadcast at ${feeRate} sat/vB`)
          } catch (e) {
            // non-BIP68-final: our MTP estimate ran ahead of the chain's — next poll.
            log.warn(`onchain ${id}: leaf spend not accepted yet: ${(e as Error).message}`)
          }
        }
      }
      await sleep(this.d.pollMs ?? 60_000)
    }
  }

  /** The VHTLC was spent on chain: by us, or by the counterparty — decide which and finish the swap. */
  private async settleSpent(row: SwapRow, spenderTxid: string, witness: Uint8Array[]): Promise<void> {
    const { store, log, locks } = this.d
    const revealed = revealedPreimage(witness, row.paymentHash)
    if (row.direction === 'send') {
      if (revealed) {
        store.transition(row.id, 'ln_inflight', 'claimed', { preimage: hex.encode(revealed) })
        this.d.emit(row.id, 'claimed')
        this.progress(row, { stage: 'done', spendTxid: spenderTxid })
        log.info(`onchain ${row.id}: claimed on chain (${spenderTxid})`)
      } else {
        // The funder's own leaf beat our claim: the timing that should prevent
        // this failed (we were offline past d_s − d_c, or fees). Loud.
        this.progress(row, { stage: 'abandoned', spendTxid: spenderTxid, reason: 'the funder took the VHTLC back before our claim landed' })
        log.error(`onchain ${row.id}: LOST — the funder spent the VHTLC (${spenderTxid}) before our claim; we paid the invoice`)
      }
      return
    }
    // receive: their claim (preimage in the witness) → settle; otherwise it was our refund
    const release = locks.tryAcquire(row.id)
    if (!release) return
    try {
      if (revealed) {
        await this.d.receive.settleWith(row.id, hex.encode(revealed))
        this.progress(row, { stage: 'done', spendTxid: spenderTxid })
        log.info(`onchain ${row.id}: the user claimed on chain (${spenderTxid}) — settled the hold invoice with their preimage`)
        return
      }
    } finally {
      release()
    }
    if (store.transition(row.id, 'funded', 'refund_wait')) this.d.emit(row.id, 'refund_wait')
    this.progress(row, { stage: 'done', spendTxid: spenderTxid })
    log.info(`onchain ${row.id}: refunded on chain (${spenderTxid}) — releasing the payer`)
    await this.d.receive.resumeRefundWait(row.id)
  }

  /**
   * Our own coins an unroll dragged on chain. The Ark tx that funds a VHTLC
   * also carries our change, so whoever unrolls the VHTLC puts that change on
   * chain too (at their cost, not ours). It stays ours through the wallet
   * script's exit leaf once the exit delay has passed — but only if someone
   * spends it: swept to the fuel address here, or it would sit there.
   */
  private async sweepOwnUnrolled(): Promise<void> {
    const { signer, provider, log } = this.d
    if (this.ownDirty || Date.now() - this.ownQueriedAt >= OWN_UNROLLED_QUERY_MS) {
      this.ownDirty = false
      this.ownQueriedAt = Date.now()
      this.ownPending = (await signer.ownUnrolledVtxos()).filter((v) => !this.ownDone.has(`${v.txid}:${v.vout}`))
    }
    const coins = this.ownPending.filter((v) => !this.ownDone.has(`${v.txid}:${v.vout}`))
    if (coins.length === 0) return
    const delay = await signer.selfDelay()
    const self = await signer.selfScript(delay)
    const blocks = timelockType(delay) === 'blocks'
    for (const coin of coins) {
      const key = `${coin.txid}:${coin.vout}`
      const status = await provider.getTxStatus(coin.txid).catch(() => undefined)
      if (!status?.confirmed) continue // the unroll is still on its way
      const outs = await provider.getTxOutspends(coin.txid)
      if (outs[coin.vout]?.spent) {
        this.ownDone.add(key)
        log.info(`onchain: our unrolled coin ${key} is spent on chain (${outs[coin.vout]!.txid ?? 'spender unknown'})`)
        continue
      }
      const matured = blocks
        ? (await provider.getChainTip()).height - status.blockHeight + 1 >= Number(delay)
        : await this.csvElapsed(status.blockHeight, Number(delay))
      if (!matured) continue
      const fuel = await this.fuel()
      const feeRate = Math.max(MIN_FEE_RATE, (await provider.getFeeRate().catch(() => undefined)) ?? MIN_FEE_RATE)
      let tx
      try {
        tx = await signLeafSpendAtRate(
          {
            txid: coin.txid,
            vout: coin.vout,
            value: coin.value,
            pkScript: self.pkScript,
            leaf: self.exit(),
            sequence: timelockToSequence({ type: blocks ? 'blocks' : 'seconds', value: delay }),
            destination: fuel.onchainP2TR.script,
          },
          feeRate,
          signer.identity,
        )
      } catch (e) {
        this.ownDone.add(key)
        log.warn(`onchain: our unrolled coin ${key} (${coin.value} sats) left on chain — ${(e as Error).message}`)
        continue
      }
      await provider.broadcastTransaction(tx.hex)
      log.info(`onchain: swept our unrolled coin ${key} (${coin.value} sats) → fuel in ${tx.id}`)
    }
  }

  /** Has `secs` of MTP passed since the block at `height` (BIP-68 time-based)? */
  private async csvElapsed(height: number, secs: number): Promise<boolean> {
    const p = this.d.provider
    if (!p.getMedianTimePast) return false
    const tip = await p.getChainTip()
    const [now, then] = await Promise.all([p.getMedianTimePast(tip.height), p.getMedianTimePast(Math.max(0, height - 1))])
    return now - then >= secs
  }

  /** The swap's VHTLC from its row: a send's sender is the user, a receive's is us. */
  private async scriptFor(row: SwapRow): Promise<ReturnType<typeof buildVhtlc>> {
    const user = hex.decode(row.userPubkey)
    const own = await this.d.signer.xOnlyPublicKey()
    const isSend = row.direction === 'send'
    return buildVhtlc({
      sender: isSend ? user : own,
      receiver: isSend ? own : user,
      server: await this.d.signer.serverXOnly(),
      paymentHash: hex.decode(row.paymentHash),
      timeouts: { refundLocktime: row.refundLocktime, ...row.vhtlc! },
    })
  }
}
