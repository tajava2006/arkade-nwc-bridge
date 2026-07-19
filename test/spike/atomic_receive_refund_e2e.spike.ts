// F2 drill (SUBDUST_ATOMIC_SECURITY_REVIEW.md) — receive UNCLAIMED refund.
// The external payer pays the hold invoice, boltz funds + pre-signs, but the
// receiver NEVER claims. After T elapses boltz's periodic scan must reclaim its
// funding (refund leaf) AND cancel the hold invoice (payer made whole). Asserts
// the shared vtxo is spent by boltz's refund, the swap reaches 'refunded', and
// the hold invoice is CANCELED.
//
//   arkade-regtest up --profile boltz (seconds mode) with BOLTZ_IMAGE=boltz-atomic:regtest
//   set subdustReceiveWindow small (e.g. 60) so T elapses within the drill.
//   bun test/spike/atomic_receive_refund_e2e.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { hex } from '@scure/base'
import { randomBytes } from '@noble/hashes/utils.js'
import { DefaultVtxo, RestArkProvider, RestIndexerProvider, SingleKey, type ArkInfo } from '@arkade-os/sdk'
import { AtomicVtxoScript } from '../../src/atomic'

const ARKD_URL = process.env.ARKD_URL ?? 'http://localhost:7070'
const BOLTZ_URL = process.env.BOLTZ_URL ?? 'http://localhost:9069'
const ARK_PW = process.env.ARKD_PASSWORD ?? 'secret'
const BOLTZ_KEY = '3820bf24c99fd1a1d20205e0237c73af9a0f998b6844aa1e87a09585354abe86'
const HRP = 'tark'
const enc = (b: Uint8Array) => hex.encode(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))
const sha256 = (b: Uint8Array) => Uint8Array.from(createHash('sha256').update(b).digest())

const REGTEST_DIR = process.env.REGTEST_DIR ?? '/Users/zxcvjklkjasdflk/dev/ark/my-server/reference/arkade-nwc-bridge/regtest-e2e/arkade-regtest'
const regtest = (...a: string[]) => execFileSync('node', ['regtest.mjs', ...a], { cwd: REGTEST_DIR, encoding: 'utf8', maxBuffer: 1e7 })
const boltzLnd = (...a: string[]) => execFileSync('docker', ['exec', 'boltz-lnd', 'lncli', '--network=regtest', ...a], { encoding: 'utf8' })

let PASS = 0
let FAIL = 0
const check = (c: boolean, l: string) => { console.log(`  ${c ? '✅' : '❌'} ${l}`); c ? PASS++ : FAIL++ }
async function boltz<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BOLTZ_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()) as T
}
async function boltzGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BOLTZ_URL}${path}`)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return (await res.json()) as T
}

async function main(): Promise<void> {
  console.log(`atomic receive UNCLAIMED-REFUND drill (F2) — boltz ${BOLTZ_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const d = info.unilateralExitDelay
  const a = 21
  const tl = { type: d >= 512n ? ('seconds' as const) : ('blocks' as const), value: d }

  const boltzKey = SingleKey.fromPrivateKey(hex.decode(BOLTZ_KEY))
  const boltzXOnly = toXOnly(await boltzKey.xOnlyPublicKey())
  const boltzAddr = new DefaultVtxo.Script({ pubKey: boltzXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)
  console.log('funding boltz mini-wallet…')
  regtest('ark', 'send', '--to', boltzAddr.encode(), '--amount', '100000', '--password', ARK_PW)
  regtest('mine', '1')
  await sleep(1500)

  const bridge = SingleKey.fromPrivateKey(randomBytes(32))
  const bridgeXOnly = toXOnly(await bridge.xOnlyPublicKey())

  const preimage = randomBytes(32)
  const H = sha256(preimage)
  const init = await boltz<{ swapId: string; invoice: string }>('/v2/subdust/atomic/receive/init', {
    amount: a, paymentHash: enc(H), userPubkey: enc(bridgeXOnly),
  })
  check(!!init.swapId, `/receive/init ok (swap ${init.swapId.slice(0, 8)}…)`)

  execFileSync('docker', ['exec', '-d', 'lnd', 'lncli', '--network=regtest', 'payinvoice', '--force', init.invoice], { encoding: 'utf8' })
  console.log('external payer paying the hold invoice (held)…')

  type Status = { state: string; fundingOutpoint?: string; refundLocktime?: number }
  let status: Status | undefined
  for (let i = 0; i < 40; i++) {
    const s: Status = await boltzGet(`/v2/subdust/atomic/receive/status?swapId=${init.swapId}`)
    status = s
    if (s.state === 'funded' && s.fundingOutpoint) break
    await sleep(1000)
  }
  check(status?.state === 'funded' && !!status.fundingOutpoint, `boltz funded + presigned (state=${status?.state})`)
  if (!status?.fundingOutpoint || status.refundLocktime === undefined) throw new Error('boltz never funded')
  const [txid, voutStr] = status.fundingOutpoint.split(':')
  const T = status.refundLocktime

  // rebuild the shared script to watch the funding vtxo
  const script = new AtomicVtxoScript({ funder: boltzXOnly, claimer: bridgeXOnly, server: serverXOnly, paymentHash: H, refundLocktime: BigInt(T), exitDelay: d })
  const sharedPk = enc(script.pkScript)
  const stillFunded = async () => (await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })).vtxos.some((v) => v.txid === txid && v.vout === Number(voutStr))
  check(await stillFunded(), 'shared vtxo present + spendable (funded, unclaimed)')

  // THE TWIST: never claim, never settle. Wait for T (wall clock), then mine so
  // the chain's median-time-past passes T — arkd enforces the refund CLTV
  // against MTP, and boltz's scan gates on it (F9). Only then does the refund
  // fire. (On mainnet the ~1h block cadence advances MTP on its own.)
  const untilT = Math.max(0, T - Math.floor(Date.now() / 1000)) + 3
  console.log(`\nleaving it UNCLAIMED — waiting ~${untilT}s for wall-clock T, then mining to push MTP past T…`)
  await sleep(untilT * 1000)
  regtest('mine', '12') // 12 blocks timestamped > T → MTP > T → refund gate opens
  console.log('mined 12 blocks; waiting for boltz refund scan…')
  let refunded = false
  let gone = false
  let invCanceled = false
  for (let i = 0; i < 100 && !(refunded && invCanceled); i++) {
    await sleep(1000)
    try { refunded = (await boltzGet<Status>(`/v2/subdust/atomic/receive/status?swapId=${init.swapId}`)).state === 'refunded' } catch { /* */ }
    try { gone = !(await stillFunded()) } catch { /* */ }
    try { invCanceled = JSON.parse(boltzLnd('lookupinvoice', enc(H))).state === 'CANCELED' } catch { /* */ }
    if (i % 20 === 19) { regtest('mine', '3'); console.log(`  … ${i + 1}s (refunded=${refunded}, vtxoGone=${gone}, invCanceled=${invCanceled})`) }
  }
  check(gone, "boltz's refund spent the shared vtxo (funding reclaimed via the refund leaf)")
  check(refunded, "swap state reached 'refunded'")
  check(invCanceled, 'hold invoice CANCELED on boltz-lnd (external payer made whole)')

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0 ? '✅ F2 REFUND WORKS — unclaimed receive reclaims boltz funding + cancels the invoice after T' : '❌ FAILURES — see above')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => { console.error('\nspike crashed:', e); process.exit(1) })
