import type { Database } from 'bun:sqlite'
import { hex } from '@scure/base'
import {
  ArkAddress,
  DefaultVtxo,
  RestArkProvider,
  RestIndexerProvider,
  type VirtualCoin,
  type Wallet,
} from '@arkade-os/sdk'
import { decodeInvoice } from '@arkade-os/boltz-swap'
import {
  AtomicVtxoScript,
  classifyResume,
  computeClaimSplit,
  presignClaim,
  refundSpend,
  serverUnrollScript,
  SqliteAtomicSwapRepository,
  SwapDirection,
  type AtomicOutput,
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
// Replaces the non-atomic plain-send branch in ln_send.ts. Everything the bridge
// needs to verify is local — boltz can't take more than the pre-signed `a`.

export interface AtomicSendDeps {
  wallet: Wallet
  /** ASP (arkd) REST base — for server params + funding lookup. */
  arkServerUrl: string
  db: Database
  /** Boltz REST base (no /v2 suffix). */
  boltzApiUrl: string
}

export interface AtomicSendResult {
  /** sats that left the wallet net of the returned change (= the invoice amount) */
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
  dust: number
  vtxoMin: number
}

const toXOnly = (k: Uint8Array): Uint8Array => (k.length === 32 ? k : k.subarray(1))
const timelockType = (v: bigint): 'seconds' | 'blocks' => (v >= 512n ? 'seconds' : 'blocks')

/**
 * Send a sub-dust amount over LN through the atomic path. The bridge funds a
 * shared vtxo of `a + dust` (so the claim change comes back as a regular vtxo),
 * pre-signs the split, then boltz pays + claims. Net wallet cost is exactly the
 * invoice amount `a`.
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

  // 2. build the shared 4-leaf script (funder=user, claimer=boltz).
  const script = new AtomicVtxoScript({
    funder: userXOnly,
    claimer: boltzXOnly,
    server: serverXOnly,
    paymentHash: H,
    refundLocktime: T,
    exitDelay: d,
  })

  // Persist BEFORE funding so a crash mid-swap is recoverable (refund after T).
  // peerPubkey/exitDelay make the row self-contained: the refund path rebuilds
  // the script from the row alone, without boltz answering ever again.
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

  // 3. fund the shared vtxo. V = a + dust → the claim change (V−a = dust) is a
  // regular vtxo the user gets back; net cost stays `a`.
  const V = a + dust
  const hrp = info.network === 'bitcoin' ? 'ark' : 'tark'
  const sharedAddress = script.address(hrp, serverXOnly).encode()
  const txid = await deps.wallet.sendBitcoin({ address: sharedAddress, amount: V })

  const { shared, coin } = await locateFunding(indexer, script, V, txid)
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

  // 4. compute the split + pre-sign the claim pair.
  const funderAddr = ArkAddress.decode(await deps.wallet.getAddress())
  const boltzAddr = new DefaultVtxo.Script({
    pubKey: boltzXOnly,
    serverPubKey: serverXOnly,
    csvTimelock: { type: timelockType(d), value: d },
  }).address(hrp, serverXOnly)
  const split = computeClaimSplit({
    funderAddress: funderAddr,
    claimerAddress: boltzAddr,
    fundingValue: V,
    amount: a,
    dust,
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
  repo.transition(init.swapId, 'claimed')
  // Terminal success: the shared vtxo is spent by the claim split (our change
  // arrives at the wallet address, where ProofSync covers it) — release the
  // lifecycle-owned vault row.
  releaseVaultRow(deps.db, shared.txid, shared.vout)
  return { amount: a, preimage: fund.preimage, txid }
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

  // Full V back to the wallet's regular address (V = a + dust ≥ dust, so this
  // is a normal vtxo — no sub-dust edge on the refund path).
  const ourAddr = ArkAddress.decode(await deps.wallet.getAddress())
  const outputs: AtomicOutput[] = [{ script: ourAddr.pkScript, amount: BigInt(coin.value) }]
  const shared: SharedVtxo = { txid, vout, value: coin.value, script }
  let refundTxid: string
  try {
    refundTxid = await refundSpend(shared, outputs, unroll, deps.wallet.identity, ark)
  } catch (e) {
    if (isBlocktimeLocked(e)) throw new RefundNotYetError(e instanceof Error ? e.message : String(e))
    throw e
  }

  if (swap.state !== 'refund_wait') repo.transition(swapId, 'refund_wait')
  repo.transition(swapId, 'refunded')
  releaseVaultRow(deps.db, txid, vout)
  return { txid: refundTxid, amount: coin.value }
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
): Promise<AtomicSendResumeResult> {
  const repo = new SqliteAtomicSwapRepository(deps.db)
  const nowSecs = BigInt(Math.floor(Date.now() / 1000))
  const result: AtomicSendResumeResult = { refunded: [], claimed: [], refundWait: [], waiting: 0, failed: [] }

  const markClaimed = (swapId: string, preimage: string | undefined, fundingOutpoint: string | undefined): void => {
    const cur = repo.get(swapId)!
    if (cur.state === 'funded') repo.transition(swapId, 'ln_inflight')
    repo.transition(swapId, 'claimed')
    if (preimage) repo.setPreimage(swapId, preimage)
    if (fundingOutpoint) {
      const [txid, vout] = fundingOutpoint.split(':')
      if (txid && vout !== undefined) releaseVaultRow(deps.db, txid, Number(vout))
    }
    result.claimed.push(swapId)
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
          // crash landed between boltz's claim and our bookkeeping
          markClaimed(swap.id, st.preimage, swap.fundingOutpoint)
          continue
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
          markClaimed(swap.id, st.preimage, swap.fundingOutpoint)
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
    const v = vtxos.find((x) => x.value === value && (x.txid === fundingTxid || true))
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
