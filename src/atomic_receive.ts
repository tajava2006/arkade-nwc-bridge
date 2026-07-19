import type { Database } from 'bun:sqlite'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  ArkAddress,
  DefaultVtxo,
  RestArkProvider,
  RestIndexerProvider,
  type Identity,
} from '@arkade-os/sdk'
import {
  AtomicVtxoScript,
  canTransition,
  computeClaimSplit,
  finishClaim,
  serverUnrollScript,
  SqliteAtomicSwapRepository,
  SwapDirection,
  isTerminal,
  type AtomicSwapState,
  type AtomicPresig,
  type SharedVtxo,
} from './atomic'

// Bridge side of the atomic sub-dust RECEIVE (LN→ARK). The bridge is the CLAIMER
// (C): it generates the preimage, gets a HOLD invoice from boltz, and once boltz
// funds a shared vtxo + pre-signs, the bridge verifies, claims its amount `a`
// (revealing the preimage), and tells boltz to settle. Because the bridge owns
// the preimage, the NIP-57 9735 receipt uses it directly — no polling boltz.
//
// Unlike the passive plain path (boltz did everything, the bridge reconciled),
// this is an ACTIVE flow the bridge drives: init → poll status → claim → settle.
// It runs on a boot + periodic pass (driveAtomicReceives) so a restart resumes
// any swap that boltz funded while we were down.

export interface AtomicReceiveDeps {
  identity: Identity
  /** ASP (arkd) REST base. */
  arkServerUrl: string
  db: Database
  /** Boltz REST base (no /v2 suffix). */
  boltzApiUrl: string
}

export interface AtomicReceiveInvoice {
  swapId: string
  invoice: string
  /** H = sha256(preimage), the BOLT11 payment hash (hex). */
  paymentHash: string
  /** The bridge's preimage (hex) — used for the 9735 receipt on settlement. */
  preimage: string
}

const toXOnly = (k: Uint8Array): Uint8Array => (k.length === 32 ? k : k.subarray(1))
const timelockType = (v: bigint): 'seconds' | 'blocks' => (v >= 512n ? 'seconds' : 'blocks')

/**
 * Walk a receive swap forward through its legal transition chain to a terminal
 * state, doing only the steps that are legal from the current state (so it's a
 * safe no-op when the swap is already there or past it). Used to converge the
 * local row when boltz reached a terminal state while we were down (F12) — e.g.
 * boltz's preimage harvester settled the hold invoice before our drive ran, so
 * our `/receive/status` poll never sees 'funded' again and the row would poll
 * forever otherwise.
 */
function advanceReceive(repo: SqliteAtomicSwapRepository, swapId: string, target: 'settled' | 'refunded'): void {
  const path: AtomicSwapState[] = target === 'settled' ? ['funded', 'claimed', 'settled'] : ['refund_wait', 'refunded']
  for (const next of path) {
    const cur = repo.get(swapId)
    if (!cur || cur.state === target || isTerminal(SwapDirection.Receive, cur.state)) return
    if (canTransition(SwapDirection.Receive, cur.state, next)) repo.transition(swapId, next)
  }
}

/**
 * Begin an atomic sub-dust receive: generate the preimage, have boltz mint a
 * HOLD invoice for it, and persist the swap so a restart can resume the claim.
 * Returns the invoice to hand the external payer.
 */
export async function issueAtomicReceive(
  deps: AtomicReceiveDeps,
  amountSats: number,
  descriptionHash?: string,
): Promise<AtomicReceiveInvoice> {
  const ark = new RestArkProvider(deps.arkServerUrl)
  const info = await ark.getInfo()
  const dust = Number(info.dust)
  if (amountSats <= 0 || amountSats >= dust) {
    throw new Error(`amount ${amountSats} is not sub-dust (dust ${dust})`)
  }

  const preimage = randomBytes(32)
  const H = sha256(preimage)
  const userXOnly = toXOnly(await deps.identity.xOnlyPublicKey())

  const init = await boltzFetch<{ swapId: string; invoice: string }>(
    `${deps.boltzApiUrl}/v2/subdust/atomic/receive/init`,
    {
      amount: amountSats,
      paymentHash: hex.encode(H),
      userPubkey: hex.encode(userXOnly),
      ...(descriptionHash ? { descriptionHash } : {}),
    },
  )

  // Persist BEFORE returning the invoice: if the payer pays and we crash, the
  // boot pass resumes the claim from the stored preimage.
  new SqliteAtomicSwapRepository(deps.db).create({
    id: init.swapId,
    direction: SwapDirection.Receive,
    paymentHash: hex.encode(H),
    state: 'invoice_issued',
    amount: amountSats,
    // T is boltz's; we don't need it until we rebuild the script at claim time,
    // where /receive/status reports it. Store 0 as a placeholder.
    refundLocktime: 0,
    invoice: init.invoice,
    preimage: hex.encode(preimage),
  })

  return { swapId: init.swapId, invoice: init.invoice, paymentHash: hex.encode(H), preimage: hex.encode(preimage) }
}

interface ReceiveStatus {
  state: string
  fundingOutpoint?: string
  presigs?: AtomicPresig
  boltzPubkey?: string
  refundLocktime?: number
  exitDelay?: string
  /**
   * BIP68 delay of boltz's OWN wallet script (its change output in the
   * presigned claim). Differs from the arkd info delay when boltz shares the
   * fulmine wallet key (fulmine pins its delay at wallet init — mainnet
   * hardcode 605184). Absent on older boltz → fall back to the info delay.
   */
  boltzScriptDelay?: string
}

/**
 * Drive one receive swap toward completion: if boltz has funded + pre-signed,
 * verify, claim (revealing the preimage), and tell boltz to settle. Idempotent
 * and restart-safe — safe to call repeatedly; it acts only when boltz is funded
 * and the swap isn't already claimed/settled. Returns true once settled.
 */
export async function driveAtomicReceive(deps: AtomicReceiveDeps, swapId: string): Promise<boolean> {
  const repo = new SqliteAtomicSwapRepository(deps.db)
  const swap = repo.get(swapId)
  if (!swap || swap.direction !== SwapDirection.Receive || swap.preimage === undefined) return false
  if (isTerminal(SwapDirection.Receive, swap.state)) return swap.state === 'settled'

  const status = await boltzGet<ReceiveStatus>(`${deps.boltzApiUrl}/v2/subdust/atomic/receive/status?swapId=${swapId}`)

  // boltz reached a terminal state while we were down — converge locally so we
  // stop polling forever (F12). 'settled': our claim's preimage was collected
  // (our /receive/settle, or boltz's harvester racing ahead of this drive) — a
  // successful receive, so return true to fire the receipt. 'refunded': boltz
  // gave the payer back (unclaimed past T); nothing to claim, terminalize quietly.
  if (status.state === 'settled') {
    advanceReceive(repo, swapId, 'settled')
    return true
  }
  if (status.state === 'refunded' || status.state === 'refund_wait') {
    advanceReceive(repo, swapId, 'refunded')
    return false
  }

  if (status.state !== 'funded' || !status.fundingOutpoint || !status.presigs || status.boltzPubkey === undefined || status.refundLocktime === undefined) {
    return false // boltz hasn't funded yet
  }

  const ark = new RestArkProvider(deps.arkServerUrl)
  const indexer = new RestIndexerProvider(deps.arkServerUrl)
  const info = await ark.getInfo()
  const server = toXOnly(hex.decode(info.signerPubkey))
  const d = info.unilateralExitDelay
  const dust = Number(info.dust)
  const a = swap.amount
  const preimage = hex.decode(swap.preimage)
  const userXOnly = toXOnly(await deps.identity.xOnlyPublicKey())
  const boltzXOnly = toXOnly(hex.decode(status.boltzPubkey))

  const script = new AtomicVtxoScript({
    funder: boltzXOnly,
    claimer: userXOnly,
    server,
    paymentHash: hex.decode(swap.paymentHash),
    refundLocktime: BigInt(status.refundLocktime),
    exitDelay: d,
  })

  const [txid, voutStr] = status.fundingOutpoint.split(':')
  if (!txid || voutStr === undefined) throw new Error(`bad funding outpoint ${status.fundingOutpoint}`)
  const sharedPk = hex.encode(script.pkScript)
  const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
  const v = vtxos.find((x) => x.txid === txid && x.vout === Number(voutStr))
  if (!v) throw new Error(`shared vtxo ${status.fundingOutpoint} not found`)

  const shared: SharedVtxo = { txid, vout: Number(voutStr), value: v.value, script }
  const hrp = info.network === 'bitcoin' ? 'ark' : 'tark'
  // boltz's change output rides on boltz's OWN wallet-script delay, not the
  // info delay — a wrong guess shifts the reconstructed claim txid off the
  // presig. Only boltz's money depends on this value; our output stays pinned
  // to our own derivation below.
  const boltzD = status.boltzScriptDelay !== undefined ? BigInt(status.boltzScriptDelay) : d
  const boltzAddr = new DefaultVtxo.Script({ pubKey: boltzXOnly, serverPubKey: server, csvTimelock: { type: timelockType(boltzD), value: boltzD } }).address(hrp, server)
  // The claimer receive address is the bridge wallet's default vtxo address.
  const bridgeAddr = new DefaultVtxo.Script({ pubKey: userXOnly, serverPubKey: server, csvTimelock: { type: timelockType(d), value: d } }).address(hrp, server)
  const split = computeClaimSplit({ funderAddress: boltzAddr, claimerAddress: bridgeAddr, fundingValue: v.value, amount: a, dust })
  const unroll = serverUnrollScript(info.checkpointTapscript)

  // Phase on the persisted state so a failed pass can retry: an attempt that
  // died after a phase must not re-run it (transition() rejects funded →
  // funded, and re-claiming an already-spent shared vtxo can't succeed).
  let state = swap.state
  if (state === 'invoice_issued') {
    repo.setFundingOutpoint(swapId, status.fundingOutpoint)
    repo.transition(swapId, 'funded')
    state = 'funded'
  }
  if (state === 'funded') {
    await finishClaim(shared, split.outputs, unroll, status.presigs, deps.identity, preimage, ark)
    repo.transition(swapId, 'claimed')
  }

  // Verify-before-reveal (F18, symmetry with the send-side F4): only tell boltz
  // to settle once our claim is actually on-chain. If finishClaim ACKed but
  // didn't register, the preimage isn't public yet — revealing it would let boltz
  // collect the LN payment while we hold nothing. Not confirmed → leave for the
  // next pass (once the claim really lands, boltz's own harvester is the backstop).
  if (!(await confirmSpent(indexer, txid, Number(voutStr)))) {
    console.warn(`atomic receive ${swapId}: claim not confirmed on-chain yet — deferring settle`)
    return false
  }

  // Reveal the preimage to boltz so it settles the hold invoice.
  await boltzFetch(`${deps.boltzApiUrl}/v2/subdust/atomic/receive/settle`, { swapId, preimage: swap.preimage })
  repo.transition(swapId, 'settled')
  return true
}

/** Has `txid:vout` been spent per the indexer? Short poll to tolerate lag. */
async function confirmSpent(indexer: RestIndexerProvider, txid: string, vout: number): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    try {
      const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid, vout }] })
      if (vtxos.find((v) => v.txid === txid && v.vout === vout)?.spentBy) return true
    } catch {
      // transient indexer error — retry
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

/**
 * Boot + periodic pass: drive every non-terminal atomic receive swap. Best-
 * effort — one swap failing (boltz not funded yet, transient) is left for the
 * next pass. Returns the swapIds that settled this pass (for receipt publish).
 */
export async function driveAtomicReceives(deps: AtomicReceiveDeps): Promise<string[]> {
  const settled: string[] = []
  const resumable = new SqliteAtomicSwapRepository(deps.db).listResumable().filter((s) => s.direction === SwapDirection.Receive)
  for (const swap of resumable) {
    try {
      if (await driveAtomicReceive(deps, swap.id)) settled.push(swap.id)
    } catch (err) {
      console.warn(`atomic receive ${swap.id} drive failed:`, err)
    }
  }
  return settled
}

async function boltzFetch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()) as T
}
async function boltzGet<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return (await res.json()) as T
}
