// F12 drill (SUBDUST_ATOMIC_SECURITY_REVIEW.md) — bridge converges on a boltz
// terminal state. The receiver (bridge) claims but crashes before recording it;
// boltz's preimage harvester settles the hold invoice on its own (F1), so boltz
// reaches 'settled'. When the bridge comes back its local row is behind
// ('funded') and its /receive/status poll now sees 'settled', never 'funded'.
// Before F12 the drive returned false on any non-'funded' status → the row
// polled forever ('claimed' zombie, no zap receipt, tx mis-flagged 'expired').
// After F12 the drive maps boltz's terminal state: converges the local row to
// 'settled' and returns true. This drill runs the real bridge driveAtomicReceive
// against a real 'settled' boltz swap and asserts that convergence.
//
// ── Regtest setup: same as atomic_receive_harvest_e2e (F1). ──────────────────
//     ARKD_VTXO_TREE_EXPIRY=7200 BOLTZ_IMAGE=boltz-atomic:regtest node regtest.mjs start --clean --profile boltz
//   bun test/spike/atomic_receive_converge_e2e.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { hex } from '@scure/base'
import { randomBytes } from '@noble/hashes/utils.js'
import { DefaultVtxo, RestArkProvider, RestIndexerProvider, SingleKey, type ArkInfo } from '@arkade-os/sdk'
import {
  AtomicVtxoScript,
  computeClaimSplit,
  finishClaim,
  serverUnrollScript,
  SqliteAtomicSwapRepository,
  SwapDirection,
  type SharedVtxo,
} from '../../src/atomic'
import { driveAtomicReceive } from '../../src/atomic/receive'

const ARKD_URL = process.env.ARKD_URL ?? 'http://localhost:7070'
const BOLTZ_URL = process.env.BOLTZ_URL ?? 'http://localhost:9069'
const ARK_PW = process.env.ARKD_PASSWORD ?? 'secret'
const BOLTZ_KEY = '3820bf24c99fd1a1d20205e0237c73af9a0f998b6844aa1e87a09585354abe86'
const HRP = 'tark'
const enc = (b: Uint8Array) => hex.encode(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))
const sha256 = (b: Uint8Array) => Uint8Array.from(createHash('sha256').update(b).digest())

const REGTEST_DIR = process.env.REGTEST_DIR ?? '/Users/zxcvjklkjasdflk/dev/ark/my-server/reference/ts-sdk/regtest'
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
  console.log(`atomic receive CONVERGE drill (F12) — boltz ${BOLTZ_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnrollScript(info.checkpointTapscript)
  const dust = Number(info.dust)
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

  // The bridge identity — this is what driveAtomicReceive will use.
  const bridge = SingleKey.fromPrivateKey(randomBytes(32))
  const bridgeXOnly = toXOnly(await bridge.xOnlyPublicKey())
  const bridgeAddr = new DefaultVtxo.Script({ pubKey: bridgeXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)

  const preimage = randomBytes(32)
  const H = sha256(preimage)
  const init = await boltz<{ swapId: string; invoice: string }>('/v2/subdust/atomic/receive/init', {
    amount: a, paymentHash: enc(H), userPubkey: enc(bridgeXOnly),
  })
  check(!!init.swapId, `/receive/init ok (swap ${init.swapId.slice(0, 8)}…)`)

  execFileSync('docker', ['exec', '-d', 'lnd', 'lncli', '--network=regtest', 'payinvoice', '--force', init.invoice], { encoding: 'utf8' })
  console.log('external payer paying the hold invoice (held)…')

  type Status = { state: string; fundingOutpoint?: string; presigs?: { arkTx: string; checkpoint: string }; refundLocktime?: number }
  let status: Status | undefined
  for (let i = 0; i < 40; i++) {
    const s: Status = await boltzGet(`/v2/subdust/atomic/receive/status?swapId=${init.swapId}`)
    status = s
    if (s.state === 'funded' && s.fundingOutpoint && s.presigs) break
    await sleep(1000)
  }
  if (!status?.fundingOutpoint || !status.presigs || status.refundLocktime === undefined) throw new Error('boltz never funded')
  check(status.state === 'funded', 'boltz funded + presigned')

  // The bridge claims on ARK (revealing the preimage) but — simulating a crash
  // right after — NEVER calls /receive/settle. boltz's harvester must settle.
  const T = BigInt(status.refundLocktime)
  const script = new AtomicVtxoScript({ funder: boltzXOnly, claimer: bridgeXOnly, server: serverXOnly, paymentHash: H, refundLocktime: T, exitDelay: d })
  const [txid, voutStr] = status.fundingOutpoint.split(':')
  const { vtxos } = await indexer.getVtxos({ scripts: [enc(script.pkScript)], spendableOnly: true })
  const v = vtxos.find((x) => x.txid === txid && x.vout === Number(voutStr))
  if (!v) throw new Error('shared vtxo not found')
  const shared: SharedVtxo = { txid: txid!, vout: Number(voutStr), value: v.value, script }
  const split = computeClaimSplit({ funderAddress: boltzAddr, claimerAddress: bridgeAddr, fundingValue: v.value, amount: a, dust })
  await finishClaim(shared, split.outputs, unroll, status.presigs, bridge, preimage, ark)
  console.log('bridge claimed (preimage revealed) — withholding /receive/settle, waiting for boltz harvester…')

  let boltzSettled = false
  for (let i = 0; i < 95 && !boltzSettled; i++) {
    await sleep(1000)
    try { boltzSettled = (await boltzGet<Status>(`/v2/subdust/atomic/receive/status?swapId=${init.swapId}`)).state === 'settled' } catch { /* */ }
    if (i % 10 === 9) console.log(`  … ${i + 1}s (boltz settled=${boltzSettled})`)
  }
  check(boltzSettled, "boltz reached 'settled' via the harvester")
  try { check(JSON.parse(boltzLnd('lookupinvoice', enc(H))).state === 'SETTLED', 'hold invoice SETTLED on boltz-lnd') } catch { check(false, 'lookupinvoice failed') }

  // ── THE F12 ASSERTION ──────────────────────────────────────────────────────
  // The bridge is back with a LOCAL row that's behind: it recorded 'funded'
  // (and the preimage) before the crash. Its /receive/status poll now returns
  // 'settled'. Run the REAL driveAtomicReceive and assert it converges instead
  // of returning false forever.
  console.log('\nsimulating a behind bridge DB (row stuck at funded) + driving it…')
  const db = new Database(':memory:')
  SqliteAtomicSwapRepository.migrate(db)
  const repo = new SqliteAtomicSwapRepository(db)
  repo.create({
    id: init.swapId,
    direction: SwapDirection.Receive,
    paymentHash: enc(H),
    state: 'invoice_issued',
    amount: a,
    refundLocktime: Number(T),
    invoice: init.invoice,
    preimage: enc(preimage),
  })
  repo.setFundingOutpoint(init.swapId, status.fundingOutpoint)
  repo.transition(init.swapId, 'funded')

  const settled = await driveAtomicReceive(
    { identity: bridge, arkServerUrl: ARKD_URL, db, boltzApiUrl: BOLTZ_URL },
    init.swapId,
  )
  const finalState = repo.get(init.swapId)?.state
  check(settled === true, 'driveAtomicReceive returned TRUE (would fire the zap receipt), not false-forever')
  check(finalState === 'settled', `local row converged to 'settled' (was 'funded'), got '${finalState}'`)

  db.close()
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0 ? '✅ F12 WORKS — bridge converges on boltz terminal state; no polling zombie, receipt fires' : '❌ FAILURES — see above')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => { console.error('\nspike crashed:', e); process.exit(1) })
