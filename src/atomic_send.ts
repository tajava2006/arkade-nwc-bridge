import type { Database } from 'bun:sqlite'
import { hex } from '@scure/base'
import {
  ArkAddress,
  DefaultVtxo,
  RestArkProvider,
  RestIndexerProvider,
  type Wallet,
} from '@arkade-os/sdk'
import { decodeInvoice } from '@arkade-os/boltz-swap'
import {
  AtomicVtxoScript,
  computeClaimSplit,
  presignClaim,
  serverUnrollScript,
  SqliteAtomicSwapRepository,
  SwapDirection,
  type SharedVtxo,
} from './atomic'

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
  repo.create({
    id: init.swapId,
    direction: SwapDirection.Send,
    paymentHash,
    state: 'init',
    amount: a,
    refundLocktime: init.refundLocktime,
    invoice,
  })

  // 3. fund the shared vtxo. V = a + dust → the claim change (V−a = dust) is a
  // regular vtxo the user gets back; net cost stays `a`.
  const V = a + dust
  const hrp = info.network === 'bitcoin' ? 'ark' : 'tark'
  const sharedAddress = script.address(hrp, serverXOnly).encode()
  const txid = await deps.wallet.sendBitcoin({ address: sharedAddress, amount: V })

  const shared = await locateFunding(indexer, script, V, txid)
  repo.setFundingOutpoint(init.swapId, `${shared.txid}:${shared.vout}`)

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

  // 5. hand boltz the presigs → it verifies, pays, claims.
  const fund = await boltzFetch<{ status: string; preimage?: string; error?: string }>(
    `${deps.boltzApiUrl}/v2/subdust/atomic/send/fund`,
    { swapId: init.swapId, fundingOutpoint: `${shared.txid}:${shared.vout}`, presigs: presig },
  )
  if (fund.status !== 'claimed' || fund.preimage === undefined) {
    repo.transition(init.swapId, fund.status === 'failed' ? 'refund_wait' : 'failed')
    throw new Error(`atomic send did not complete (${fund.status}): ${fund.error ?? ''} — funds refundable after T`)
  }
  repo.transition(init.swapId, 'claimed')
  return { amount: a, preimage: fund.preimage, txid }
}

// Find the shared vtxo created by the funding tx (match the shared pkScript,
// preferring the funding txid).
async function locateFunding(
  indexer: RestIndexerProvider,
  script: AtomicVtxoScript,
  value: number,
  fundingTxid: string,
): Promise<SharedVtxo> {
  const pk = hex.encode(script.pkScript)
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [pk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === value && (x.txid === fundingTxid || true))
    if (v) return { txid: v.txid, vout: v.vout, value: v.value, script }
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
