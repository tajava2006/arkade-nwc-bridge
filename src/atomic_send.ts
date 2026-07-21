import type { Database } from 'bun:sqlite'
import { hex } from '@scure/base'
import {
  ArkAddress,
  DefaultVtxo,
  RestArkProvider,
  RestIndexerProvider,
  type ArkTxInput,
  type VirtualCoin,
  type Wallet,
} from '@arkade-os/sdk'
import { decodeInvoice } from '@arkade-os/boltz-swap'
import {
  AtomicVtxoScript,
  classifyResume,
  computeClaimSplit,
  fundShared,
  presignClaim,
  refundSpend,
  selectFundingInputs,
  serverUnrollScript,
  SqliteAtomicSwapRepository,
  SwapDirection,
  type AtomicOutput,
  type AtomicSwapRow,
  type SharedVtxo,
} from './atomic'
import { captureVtxo, expirySec } from './exit/proof_sync'
import { gcOrphanProofs, removeVtxo } from './exit/vault'

// Bridge side of the atomic sub-dust SEND (ARK -> LN). The bridge is the funder
// (F): it funds a 4-leaf shared vtxo, pre-signs the claim split, and hands the
// presigs to boltz, which pays the invoice and claims its amount `a`. If boltz
// never pays, the bridge reclaims the full funding after T (refund executor,
// wired at boot). Trustless for the user: worst case is unilateral exit.
//
// The sub-dust branch of ln_send.ts, and the only one. Everything the bridge
// needs to verify is local — boltz can't take more than the pre-signed `a`.

export interface AtomicSendDeps {
  wallet: Wallet
  /** ASP (arkd) REST base — for server params + funding lookup. */
  arkServerUrl: string
  db: Database
  /** Boltz REST base (no /v2 suffix). */
  boltzApiUrl: string
  /**
   * Esplora REST base (optional). When set, the refund path estimates the
   * chain's MTP before submitting — a submit while blocktime < T is not just
   * rejected, it poisons that arkTxid's event stream on arkd (see
   * collaborativeSpend), so not asking is better than asking early.
   */
  esploraUrl?: string
}

export interface AtomicSendResult {
  /** sats that left the wallet net of the returned change (invoice amount + boltz feeSats) */
  amount: number
  preimage: string
  /** funding arkTxid */
  txid: string
}

interface InitResponse {
  swapId: string
  boltzPubkey: string
  refundLocktime: number
  exitDelay: string
  /**
   * BIP68 delay of boltz's OWN wallet script — its claim output must be built
   * with this, not exitDelay: they differ when boltz shares the fulmine wallet
   * key (fulmine pins its delay at wallet init — mainnet hardcode 605184).
   * Absent on older boltz → fall back to exitDelay.
   */
  boltzScriptDelay?: string
  /**
   * Fee (sats) boltz reserves in the claim split for fronting the LN routing
   * cost. Taken verbatim — the split must be byte-identical on both sides, so
   * mirroring a percent formula would risk ±1 ceil disagreements (= hard
   * presig rejection). Absent on older boltz → 0.
   */
  feeSats?: number
  dust: number
  vtxoMin: number
}

const toXOnly = (k: Uint8Array): Uint8Array => (k.length === 32 ? k : k.subarray(1))
const timelockType = (v: bigint): 'seconds' | 'blocks' => (v >= 512n ? 'seconds' : 'blocks')

/** Funding-input batch expiry must clear T by this (mirror of boltz's payMargin). */
const FUNDING_MARGIN_SECS = 600

/**
 * Verify-before-bookkeep (F4, SUBDUST_ATOMIC_SECURITY_REVIEW.md): boltz replying
 * `status: 'claimed'` is NOT proof it actually spent our funding — a lying/buggy
 * boltz (or a claim that ACKed but never registered) would otherwise get us to
 * terminal-claim + delete the vault row while our whole V is still locked in the
 * shared vtxo. Only the indexer showing the outpoint spent (spentBy set) is
 * proof. Polls to tolerate indexer lag; conservative — an ambiguous/absent read
 * returns false, keeping the swap recoverable (the refund executor reclaims V).
 */
async function confirmClaimSpent(indexer: RestIndexerProvider, txid: string, vout: number): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    try {
      const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid, vout }] })
      const coin = vtxos.find((v) => v.txid === txid && v.vout === vout)
      if (coin?.spentBy) return true
    } catch {
      // transient indexer error — retry
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

/**
 * Send a sub-dust amount over LN through the atomic path. The bridge funds a
 * shared vtxo from its own vtxos spent WHOLE (V′ ≥ a + fee + dust, no funding
 * change), pre-signs the split, then boltz pays + claims a (+ its advertised
 * feeSats — it fronts the LN routing cost). The claim change V′ − a − fee comes
 * back as one regular vtxo; net wallet cost is a + fee.
 */
export async function atomicSubdustSend(
  deps: AtomicSendDeps,
  invoice: string,
  invoiceSats: number,
): Promise<AtomicSendResult> {
  const ark = new RestArkProvider(deps.arkServerUrl)
  const indexer = new RestIndexerProvider(deps.arkServerUrl)
  const repo = new SqliteAtomicSwapRepository(deps.db)

  const paymentHash = decodeInvoice(invoice).paymentHash
  if (paymentHash === undefined) throw new Error('invoice has no payment hash')
  const H = hex.decode(paymentHash)
  const a = invoiceSats

  const info = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnrollScript(info.checkpointTapscript)
  const dust = Number(info.dust)
  if (a >= dust) throw new Error(`amount ${a} is not sub-dust (dust ${dust})`)

  const userXOnly = toXOnly(await deps.wallet.identity.xOnlyPublicKey())

  // 1. init — boltz returns its pubkey + T + d (commits no capital).
  const init = await boltzFetch<InitResponse>(`${deps.boltzApiUrl}/v2/subdust/atomic/send/init`, {
    invoice,
    userPubkey: hex.encode(userXOnly),
  })
  const boltzXOnly = toXOnly(hex.decode(init.boltzPubkey))
  const T = BigInt(init.refundLocktime)
  const d = BigInt(init.exitDelay)
  // boltz's advertised fee, sanity-capped: it rides on OUR funding, so refuse
  // anything a sane operator wouldn't configure before locking coins to it.
  const fee = init.feeSats ?? 0
  if (!Number.isInteger(fee) || fee < 0 || fee > dust) {
    throw new Error(`boltz advertised an unreasonable feeSats ${init.feeSats} — refusing to fund`)
  }

  // 2. build the shared 4-leaf script (funder=user, claimer=boltz).
  const script = new AtomicVtxoScript({
    funder: userXOnly,
    claimer: boltzXOnly,
    server: serverXOnly,
    paymentHash: H,
    refundLocktime: T,
    exitDelay: d,
  })

  // 3. fund the shared vtxo with our own vtxos spent WHOLE (same selection the
  // boltz receive funder uses — ascending accumulation until V is covered, so
  // the smallest fragments get consolidated by the returning change). No
  // funding change ⇒ the wallet can never be left with a sub-dust remainder
  // here; the claim split returns V′ − a − fee (≥ dust ⇒ regular).
  // V′ ≥ a + fee + dust; net cost stays a + fee.
  const hrp = info.network === 'bitcoin' ? 'ark' : 'tark'
  const userScript = new DefaultVtxo.Script({
    pubKey: userXOnly,
    serverPubKey: serverXOnly,
    csvTimelock: { type: timelockType(BigInt(info.unilateralExitDelay)), value: BigInt(info.unilateralExitDelay) },
  })
  const { vtxos: ownVtxos } = await indexer.getVtxos({
    scripts: [hex.encode(userScript.pkScript)],
    spendableOnly: true,
  })
  const funding = selectFundingInputs(ownVtxos, {
    dust,
    refundLocktime: T,
    marginSecs: FUNDING_MARGIN_SECS,
    amount: a + fee,
  })
  if (funding.length === 0) {
    throw new Error(
      `atomic send needs ${a + fee + dust} sats of eligible vtxos (regular, spendable, batch expiry past T+${FUNDING_MARGIN_SECS}s) — ` +
        `sub-dust/swept funds and soon-expiring vtxos don't qualify`,
    )
  }

  // Persist now — BEFORE funding (fundShared), so a crash mid-swap is
  // recoverable (refund after T); peerPubkey/exitDelay make the row
  // self-contained for the offline refund path. NOT earlier: a pre-funding
  // failure (insufficient balance above) must not leave an 'init' row behind
  // that blocks retrying the same invoice — boltz's /send/init is idempotent for
  // an unfunded row, so the retry gets the same swapId and this create runs
  // cleanly (F17).
  repo.create({
    id: init.swapId,
    direction: SwapDirection.Send,
    paymentHash,
    state: 'init',
    amount: a,
    refundLocktime: init.refundLocktime,
    invoice,
    peerPubkey: hex.encode(boltzXOnly),
    exitDelay: Number(d),
  })

  const funderInputs: ArkTxInput[] = funding.map((f) => ({
    txid: f.txid,
    vout: f.vout,
    value: f.value,
    tapLeafScript: userScript.forfeit(),
    tapTree: userScript.encode(),
  }))
  const Vp = funding.reduce((n, f) => n + f.value, 0)
  const outpoint = await fundShared(
    funderInputs,
    [{ script: script.pkScript, amount: BigInt(Vp) }],
    unroll,
    deps.wallet.identity,
    ark,
  )
  const txid = outpoint.txid

  const { shared, coin } = await locateFunding(indexer, script, Vp, txid)
  repo.setFundingOutpoint(init.swapId, `${shared.txid}:${shared.vout}`)

  // Mirror the shared vtxo's exit material into the vault before boltz gets to
  // act: it lives at a script address the wallet never lists, so ProofSync
  // alone would leave it invisible — and the ASP dying mid-swap is exactly
  // when the pre-signed chain is needed (ATOMIC_SUBDUST_PLAN.md §8).
  // Best-effort: a degraded safety mirror must not fail the swap.
  try {
    await captureVtxo(deps.db, indexer, {
      txid: shared.txid,
      vout: shared.vout,
      valueSat: shared.value,
      source: 'atomic',
      script: hex.encode(script.pkScript),
      tapTree: hex.encode(script.encode()),
      status: coin.virtualStatus?.state ?? 'unknown',
      expiresAt: expirySec(coin),
    })
  } catch (err) {
    console.warn(`atomic send ${init.swapId}: vault capture failed (swap unaffected):`, err)
  }

  // 4. compute the split + pre-sign the claim pair. boltz's output uses
  // boltz's own wallet-script delay (boltzScriptDelay) — building it with d
  // would make boltz's sendFund reconstruction reject our presigs.
  const funderAddr = ArkAddress.decode(await deps.wallet.getAddress())
  const boltzD = init.boltzScriptDelay !== undefined ? BigInt(init.boltzScriptDelay) : d
  const boltzAddr = new DefaultVtxo.Script({
    pubKey: boltzXOnly,
    serverPubKey: serverXOnly,
    csvTimelock: { type: timelockType(boltzD), value: boltzD },
  }).address(hrp, serverXOnly)
  const split = computeClaimSplit({
    funderAddress: funderAddr,
    claimerAddress: boltzAddr,
    fundingValue: Vp,
    amount: a,
    dust,
    // boltz's advertised fee — folded into its claim output (a + fee, one
    // note). Must mirror its sendFund reconstruction exactly.
    feeSats: fee,
  })
  const presig = await presignClaim(shared, split.outputs, unroll, deps.wallet.identity)
  repo.setPresigs(init.swapId, presig)
  repo.transition(init.swapId, 'funded')

  // 5. hand boltz the presigs → it verifies, pays, claims. Handing them over =
  // boltz's LN pay is now in flight (the state machine requires this hop:
  // claimed/refund_wait are only reachable from ln_inflight, not funded).
  repo.transition(init.swapId, 'ln_inflight')
  const fund = await boltzFetch<{ status: string; preimage?: string; error?: string }>(
    `${deps.boltzApiUrl}/v2/subdust/atomic/send/fund`,
    { swapId: init.swapId, fundingOutpoint: `${shared.txid}:${shared.vout}`, presigs: presig },
  )
  if (fund.status !== 'claimed' || fund.preimage === undefined) {
    repo.transition(init.swapId, fund.status === 'failed' ? 'refund_wait' : 'failed')
    throw new Error(`atomic send did not complete (${fund.status}): ${fund.error ?? ''} — funds refundable after T`)
  }
  // Verify-before-bookkeep (F4): confirm boltz actually spent our funding before
  // terminal-claiming + releasing the vault row. The LN payment already
  // succeeded (we hold the preimage), so we still report success either way —
  // but if the claim hasn't landed on-chain we keep the swap recoverable in
  // ln_inflight so the refund executor reclaims V after T (boltz can't have it
  // both ways: it took V, or we get it back).
  if (await confirmClaimSpent(indexer, shared.txid, shared.vout)) {
    repo.transition(init.swapId, 'claimed')
    // Terminal success: the shared vtxo is spent by the claim split (our change
    // arrives at the wallet address, where ProofSync covers it) — release the
    // lifecycle-owned vault row.
    releaseVaultRow(deps.db, shared.txid, shared.vout)
  } else {
    repo.setPreimage(init.swapId, fund.preimage)
    console.warn(
      `atomic send ${init.swapId}: boltz reported claimed but the shared vtxo isn't spent per the indexer — keeping recoverable (F4); refund executor reclaims V after T`,
    )
  }
  return { amount: a + fee, preimage: fund.preimage, txid }
}

export interface AtomicRefundResult {
  /** refund arkTxid */
  txid: string
  /** full funding value V returned to the wallet */
  amount: number
}

/**
 * T has passed on the wall clock but not on the chain: arkd enforces the CLTV
 * against BLOCKTIME (MTP-ish), which lags wall clocks — ~1h on mainnet
 * (measured on regtest in the #14 T-refund drill: FORFEIT_CLOSURE_LOCKED).
 * Not a failure — the executor retries on its next pass.
 */
export class RefundNotYetError extends Error {
  constructor(detail: string) {
    super(
      `chain time has not passed T yet (arkd checks blocktime, which lags wall clocks ~1h on mainnet) — retry shortly. ${detail}`,
    )
    this.name = 'RefundNotYetError'
  }
}

const isBlocktimeLocked = (e: unknown): boolean =>
  e instanceof Error &&
  (/FORFEIT_CLOSURE_LOCKED/.test(e.message) || (e as { code?: number }).code === 11)

/**
 * Estimate the chain's MTP (BIP-113 median time past) from esplora — the
 * clock arkd enforces CLTV against. Best-effort: undefined on any failure
 * (the jitter + post-verify still protect the submit path).
 *
 * Esplora's /blocks returns the 10 newest block headers; the true MTP is the
 * median of the last 11. Sorting the 10 newest and taking index 4 equals the
 * 11-median exactly when the missing 11th-newest block carries the window's
 * smallest timestamp (the common case); otherwise it's off by one step —
 * acceptable for a pre-flight gate.
 */
async function estimateMtp(esploraUrl: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${esploraUrl}/blocks`)
    if (!res.ok) return undefined
    const blocks = (await res.json()) as { timestamp?: number }[]
    const ts = blocks
      .map((b) => b.timestamp)
      .filter((t): t is number => typeof t === 'number')
      .slice(0, 10)
      .sort((a, b) => a - b)
    if (ts.length < 5) return undefined
    return ts[Math.max(0, ts.length - 6)] // 10 entries → index 4
  } catch {
    return undefined
  }
}

/**
 * Reclaim the full funding V of a send swap through the refund leaf (CLTV T,
 * F+server — no boltz involvement). Callable from the dashboard and the boot
 * refund executor; rebuilds the 4-leaf script from the swap row alone
 * (peerPubkey/exitDelay), so it works even if boltz is gone for good.
 */
export async function refundAtomicSend(
  deps: Omit<AtomicSendDeps, 'boltzApiUrl'>,
  swapId: string,
): Promise<AtomicRefundResult> {
  const repo = new SqliteAtomicSwapRepository(deps.db)
  const swap = repo.get(swapId)
  if (!swap) throw new Error(`unknown swap ${swapId}`)
  if (swap.direction !== SwapDirection.Send) {
    throw new Error('only send swaps are refundable from this side (receive refunds are boltz\'s)')
  }
  if (!['funded', 'ln_inflight', 'refund_wait'].includes(swap.state)) {
    throw new Error(`swap is ${swap.state} — nothing to refund`)
  }
  if (!swap.fundingOutpoint) throw new Error('swap has no funding outpoint')
  if (!swap.peerPubkey || swap.exitDelay === undefined) {
    throw new Error('swap row predates the script-rebuild metadata (peer_pubkey/exit_delay)')
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (nowSec < swap.refundLocktime) {
    throw new Error(
      `refund locktime not reached — ${swap.refundLocktime - nowSec}s until T (CLTV would reject)`,
    )
  }
  // Pre-flight MTP gate: arkd enforces T against blocktime (MTP), and a
  // rejected submit POISONS that arkTxid's event stream (silent no-op on
  // retry — see collaborativeSpend). Don't even ask until the chain clock
  // has plausibly passed T.
  if (deps.esploraUrl) {
    const mtp = await estimateMtp(deps.esploraUrl)
    if (mtp !== undefined && mtp < swap.refundLocktime) {
      throw new RefundNotYetError(`chain MTP ${mtp} < T ${swap.refundLocktime} (esplora pre-check)`)
    }
  }

  const ark = new RestArkProvider(deps.arkServerUrl)
  const indexer = new RestIndexerProvider(deps.arkServerUrl)
  const info = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnrollScript(info.checkpointTapscript)
  const userXOnly = toXOnly(await deps.wallet.identity.xOnlyPublicKey())

  const script = new AtomicVtxoScript({
    funder: userXOnly,
    claimer: toXOnly(hex.decode(swap.peerPubkey)),
    server: serverXOnly,
    paymentHash: hex.decode(swap.paymentHash),
    refundLocktime: BigInt(swap.refundLocktime),
    exitDelay: BigInt(swap.exitDelay),
  })

  const [txid, voutStr] = swap.fundingOutpoint.split(':')
  if (!txid || voutStr === undefined) throw new Error(`bad funding outpoint ${swap.fundingOutpoint}`)
  const vout = Number(voutStr)
  const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(script.pkScript)], spendableOnly: true })
  const coin = vtxos.find((x) => x.txid === txid && x.vout === vout)
  if (!coin) {
    throw new Error('shared vtxo not found or already spent — boltz may have claimed after all; check the swap status')
  }

  const ourAddr = ArkAddress.decode(await deps.wallet.getAddress())
  const shared: SharedVtxo = { txid, vout, value: coin.value, script }
  const dust = Number(info.dust)

  // Attempt 1 is the clean single output (full V, one regular vtxo). If arkd
  // ACKs but never registers the spend — the poisoned-txid no-op — the SAME
  // txid can never succeed again, so subsequent attempts re-mint a fresh txid
  // by splitting V across a regular + a sub-dust output to OUR OWN address, in
  // varying ratios (k = the sub-dust part). Same total back to us; only the
  // txid changes. This also self-heals a swap already poisoned by a prior
  // build. maxK is bounded by the regular part staying ≥ dust.
  const maxK = Math.min(20, coin.value - dust)
  const attempts: AtomicOutput[][] = [[{ script: ourAddr.pkScript, amount: BigInt(coin.value) }]]
  for (let k = 1; k <= maxK; k++) {
    attempts.push([
      { script: ourAddr.pkScript, amount: BigInt(coin.value - k) },
      { script: ourAddr.subdustPkScript, amount: BigInt(k) },
    ])
  }

  const registered = async (): Promise<boolean> => {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const { vtxos: check } = await indexer.getVtxos({
        scripts: [hex.encode(script.pkScript)],
        spendableOnly: true,
      })
      if (!check.some((x) => x.txid === txid && x.vout === vout)) return true
    }
    return false
  }

  let refundTxid = ''
  for (const outputs of attempts) {
    let attemptTxid: string
    try {
      attemptTxid = await refundSpend(shared, outputs, unroll, deps.wallet.identity, ark)
    } catch (e) {
      if (isBlocktimeLocked(e)) throw new RefundNotYetError(e instanceof Error ? e.message : String(e))
      throw e
    }
    // Verify-before-bookkeep: arkd's ACK is NOT registration (its event save +
    // projection are server-side-log-only; a poisoned stream no-ops silently —
    // mainnet false-refund 2026-07-17). Only the indexer dropping the funding
    // outpoint proves the spend landed.
    if (await registered()) {
      refundTxid = attemptTxid
      break
    }
    console.warn(`atomic refund ${swapId}: ${attemptTxid.slice(0, 12)}… ACKed but not registered (poisoned txid) — re-minting`)
  }
  if (!refundTxid) {
    throw new Error(
      `refund never registered after ${attempts.length} txid variants (shared vtxo still spendable) — retrying next pass`,
    )
  }

  if (swap.state !== 'refund_wait') repo.transition(swapId, 'refund_wait')
  repo.transition(swapId, 'refunded')
  releaseVaultRow(deps.db, txid, vout)
  return { txid: refundTxid, amount: coin.value }
}

/**
 * Crash-window recovery (F15): a send row can be left at 'init' with no
 * fundingOutpoint if the bridge died between fundShared and setFundingOutpoint —
 * the shared vtxo is on-chain but unrecorded, so classifyResume never refunds it
 * and V stays locked. Rebuild the 4-leaf script from the row, look for the
 * shared vtxo at that address, and if it's there record the outpoint + advance
 * to 'funded' so the normal refund path reclaims it after T. Returns true if
 * recovered. Needs peerPubkey + exitDelay (rows predating that metadata are left
 * alone — nothing to rebuild the script from). boltz never got presigs in this
 * window, so the vtxo can't have been claimed: a spendable coin at the script is
 * ours.
 */
async function recoverFundingOutpoint(
  deps: AtomicSendDeps,
  repo: SqliteAtomicSwapRepository,
  swap: AtomicSwapRow,
): Promise<boolean> {
  if (swap.fundingOutpoint || swap.state !== 'init' || !swap.peerPubkey || swap.exitDelay === undefined) {
    return false
  }
  const ark = new RestArkProvider(deps.arkServerUrl)
  const indexer = new RestIndexerProvider(deps.arkServerUrl)
  const info = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const userXOnly = toXOnly(await deps.wallet.identity.xOnlyPublicKey())
  const script = new AtomicVtxoScript({
    funder: userXOnly,
    claimer: toXOnly(hex.decode(swap.peerPubkey)),
    server: serverXOnly,
    paymentHash: hex.decode(swap.paymentHash),
    refundLocktime: BigInt(swap.refundLocktime),
    exitDelay: BigInt(swap.exitDelay),
  })
  const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(script.pkScript)], spendableOnly: true })
  const coin = vtxos[0]
  if (!coin) return false
  repo.setFundingOutpoint(swap.id, `${coin.txid}:${coin.vout}`)
  repo.transition(swap.id, 'funded')
  console.log(`atomic send ${swap.id}: recovered funding ${coin.txid}:${coin.vout} lost to a crash before bookkeeping (F15)`)
  return true
}

// ── boot / periodic resume (the "#14 timer") ─────────────────────────────────

export interface AtomicSendResumeResult {
  /** swaps whose full V came back through the refund leaf this pass */
  refunded: string[]
  /** swaps reconciled to claimed via boltz status (crash after boltz's claim) */
  claimed: string[]
  /** swaps moved to refund_wait (boltz reports the LN pay failed) */
  refundWait: string[]
  /** non-terminal swaps with nothing to do yet (pre-T, or blocktime still lagging) */
  waiting: number
  failed: { id: string; error: string }[]
}

type SendStatus = { state: string; preimage?: string }

/** boltz being unreachable is an expected input here, not an error. */
async function sendStatusSafe(boltzApiUrl: string, swapId: string): Promise<SendStatus | undefined> {
  try {
    const res = await fetch(`${boltzApiUrl}/v2/subdust/atomic/send/status?swapId=${encodeURIComponent(swapId)}`)
    if (!res.ok) return undefined
    return (await res.json()) as SendStatus
  } catch {
    return undefined
  }
}

/**
 * One pass over non-terminal SEND swaps (boot + every reconcile tick),
 * following classifyResume (§3.4):
 *
 * - post-T → refund. One boltz status check first when reachable: a crash
 *   between boltz's claim and our bookkeeping leaves a row whose vtxo is
 *   already spent — reconcile that to claimed instead of a doomed refund.
 *   boltz unreachable → straight to refund (that IS the refund scenario).
 * - pre-T (funded/ln_inflight) → poll boltz: claimed lands the terminal
 *   bookkeeping (+ vault release), failed moves to refund_wait for T.
 * - RefundNotYetError (blocktime lag) counts as waiting, not failure.
 *
 * `refund` is injectable for unit tests — the real one is e2e-proven
 * (atomic_refund_e2e drill).
 */
export async function resumeAtomicSends(
  deps: AtomicSendDeps,
  refund: (d: Omit<AtomicSendDeps, 'boltzApiUrl'>, id: string) => Promise<AtomicRefundResult> = refundAtomicSend,
  // injectable for unit tests; production binds it to the arkd indexer (F4).
  confirmSpent?: (txid: string, vout: number) => Promise<boolean>,
): Promise<AtomicSendResumeResult> {
  const repo = new SqliteAtomicSwapRepository(deps.db)
  const indexer = new RestIndexerProvider(deps.arkServerUrl)
  const confirm =
    confirmSpent ?? ((txid: string, vout: number): Promise<boolean> => confirmClaimSpent(indexer, txid, vout))
  const nowSecs = BigInt(Math.floor(Date.now() / 1000))
  const result: AtomicSendResumeResult = { refunded: [], claimed: [], refundWait: [], waiting: 0, failed: [] }

  // Returns true when the swap was actually terminal-claimed, false when boltz's
  // claim couldn't be confirmed on-chain (caller decides what to do with a
  // false — post-T it must fall through to refund, F11).
  const markClaimed = async (swapId: string, preimage: string | undefined, fundingOutpoint: string | undefined): Promise<boolean> => {
    // Verify-before-bookkeep (F4): don't terminal-claim + release the vault on
    // boltz's word alone — confirm the shared vtxo is actually spent first. If
    // it isn't, persist the preimage and leave the swap recoverable (the refund
    // executor reclaims V after T); a later pass reconciles if boltz claims late.
    if (fundingOutpoint) {
      const [txid, vout] = fundingOutpoint.split(':')
      if (txid && vout !== undefined && !(await confirm(txid, Number(vout)))) {
        if (preimage) repo.setPreimage(swapId, preimage)
        console.warn(`atomic send ${swapId}: boltz status=claimed but the shared vtxo isn't spent — not releasing (F4)`)
        return false
      }
    }
    const cur = repo.get(swapId)!
    if (cur.state === 'funded') repo.transition(swapId, 'ln_inflight')
    repo.transition(swapId, 'claimed')
    if (preimage) repo.setPreimage(swapId, preimage)
    if (fundingOutpoint) {
      const [txid, vout] = fundingOutpoint.split(':')
      if (txid && vout !== undefined) releaseVaultRow(deps.db, txid, Number(vout))
    }
    result.claimed.push(swapId)
    return true
  }

  // Crash-window recovery pre-pass (F15): promote any 'init' send whose funding
  // is already on-chain but unrecorded to 'funded', so the loop below refunds it
  // after T instead of polling boltz forever with V stranded in the shared vtxo.
  for (const swap of repo.listResumable()) {
    if (swap.direction === SwapDirection.Send && !swap.fundingOutpoint && swap.state === 'init') {
      try {
        await recoverFundingOutpoint(deps, repo, swap)
      } catch (e) {
        result.failed.push({ id: swap.id, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  for (const swap of repo.listResumable()) {
    if (swap.direction !== SwapDirection.Send) continue
    const action = classifyResume({
      direction: swap.direction,
      state: swap.state,
      refundLocktime: BigInt(swap.refundLocktime),
      nowSecs,
    })
    try {
      if (action === 'refund') {
        const st = await sendStatusSafe(deps.boltzApiUrl, swap.id)
        if (st?.state === 'claimed' && swap.state !== 'refund_wait') {
          // crash landed between boltz's claim and our bookkeeping — reconcile
          // to claimed only if the spend is actually on-chain (F4). If it isn't
          // (boltz lying / ACK-but-no-register), DON'T continue: fall through to
          // refund — our V is still in the shared vtxo and T has passed (F11).
          // refund fails loudly if the vtxo turns out spent, so no double-spend.
          if (await markClaimed(swap.id, st.preimage, swap.fundingOutpoint)) continue
        }
        // (a refund_wait row boltz claims to have claimed would mean boltz paid
        // after reporting failure — a §3.5 discipline violation; the refund
        // below then fails loudly on the spent vtxo instead of us guessing)
        const r = await refund(deps, swap.id)
        console.log(`atomic send ${swap.id}: refunded ${r.amount} sats after T (arkTx ${r.txid.slice(0, 12)}…)`)
        result.refunded.push(swap.id)
      } else if (action === 'poll') {
        const st = await sendStatusSafe(deps.boltzApiUrl, swap.id)
        if (st?.state === 'claimed') {
          // pre-T: if the spend isn't confirmed yet, keep it recoverable and
          // count it as still waiting (the next tick re-checks / T-refund covers).
          if (!(await markClaimed(swap.id, st.preimage, swap.fundingOutpoint))) result.waiting++
        } else if (st?.state === 'failed' || st?.state === 'refund_wait') {
          if (swap.state !== 'refund_wait') repo.transition(swap.id, 'refund_wait')
          result.refundWait.push(swap.id)
        } else {
          result.waiting++
        }
      } else {
        // wait_refund / none — T not reached, nothing to execute
        result.waiting++
      }
    } catch (e) {
      if (e instanceof RefundNotYetError) {
        result.waiting++ // blocktime lag — the next pass retries
      } else {
        result.failed.push({ id: swap.id, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  return result
}

/** Terminal state housekeeping: drop the lifecycle-owned vault row + orphaned proofs. */
function releaseVaultRow(db: Database, txid: string, vout: number): void {
  try {
    removeVtxo(db, txid, vout)
    gcOrphanProofs(db)
  } catch (err) {
    console.warn(`atomic: vault release failed for ${txid}:${vout}:`, err)
  }
}

// Find the shared vtxo created by the funding tx (match the shared pkScript,
// preferring the funding txid).
async function locateFunding(
  indexer: RestIndexerProvider,
  script: AtomicVtxoScript,
  value: number,
  fundingTxid: string,
): Promise<{ shared: SharedVtxo; coin: VirtualCoin }> {
  const pk = hex.encode(script.pkScript)
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [pk], spendableOnly: true })
    // The shared vtxo's txid IS the funding arkTxid (vout 0), so match on it
    // precisely; fall back to a value match only if the txid isn't indexed yet.
    const v = vtxos.find((x) => x.txid === fundingTxid) ?? vtxos.find((x) => x.value === value)
    if (v) return { shared: { txid: v.txid, vout: v.vout, value: v.value, script }, coin: v }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`shared vtxo (value=${value}) never appeared after funding ${fundingTxid}`)
}

async function boltzFetch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as T
}
