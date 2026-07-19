// F1 drill (SUBDUST_ATOMIC_SECURITY_REVIEW.md) — receive preimage HARVEST.
// Identical to atomic_receive_e2e up to the claim, then the malicious twist:
// the bridge (claimer) claims `a` on ARK (revealing the preimage on-chain) and
// NEVER calls /receive/settle. boltz must still settle the hold invoice on its
// own, by harvesting the preimage from the claim tx — else a griefer takes `a`
// for free. Asserts boltz auto-settles WITHOUT our settle call.
//
// ── Regtest setup (self-contained; the arkade-regtest submodule is UPSTREAM
//    code — do NOT commit config there) ───────────────────────────────────────
// Add to its docker/compose.ark.yml, boltz service, BOLTZ_CONFIG [ark] table
// (revert after the drill):
//     subdustRestUrl   = "http://arkd:7070"
//     subdustSignerKey = "3820bf24c99fd1a1d20205e0237c73af9a0f998b6844aa1e87a09585354abe86"  # = BOLTZ_KEY below
//     subdustReceiveWindow = 60      # small so a receive T elapses within a drill
//     subdustSendWindow    = 86400   # large so a send's cltvLimit stays routable
// Bring the stack up with a long tree-expiry (the 1024 default expires funding
// vtxos mid-drill) and the custom image:
//     ARKD_VTXO_TREE_EXPIRY=7200 BOLTZ_IMAGE=boltz-atomic:regtest node regtest.mjs start --clean --profile boltz
//   bun test/spike/atomic_receive_harvest_e2e.spike.ts
//
// NOTE: boltz's harvester runs on a 60s scan, so this drill waits up to ~90s
// for the auto-settle. That patience IS the assertion.

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { hex } from '@scure/base'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  DefaultVtxo,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  type ArkInfo,
} from '@arkade-os/sdk'
import { AtomicVtxoScript, computeClaimSplit, finishClaim, serverUnrollScript, type SharedVtxo } from '../../src/atomic'

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
const regtest = (...a: string[]) =>
  execFileSync('node', ['regtest.mjs', ...a], { cwd: REGTEST_DIR, encoding: 'utf8', maxBuffer: 1e7 })
const boltzLnd = (...a: string[]) =>
  execFileSync('docker', ['exec', 'boltz-lnd', 'lncli', '--network=regtest', ...a], { encoding: 'utf8' })

let PASS = 0
let FAIL = 0
const check = (c: boolean, l: string) => {
  console.log(`  ${c ? '✅' : '❌'} ${l}`)
  c ? PASS++ : FAIL++
}
async function boltz<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BOLTZ_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()) as T
}
async function boltzGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BOLTZ_URL}${path}`)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return (await res.json()) as T
}

async function main(): Promise<void> {
  console.log(`atomic receive HARVEST drill (F1) — boltz ${BOLTZ_URL}, arkd ${ARKD_URL}\n`)
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

  const bridge = SingleKey.fromPrivateKey(randomBytes(32))
  const bridgeXOnly = toXOnly(await bridge.xOnlyPublicKey())
  const bridgeAddr = new DefaultVtxo.Script({ pubKey: bridgeXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)

  const preimage = randomBytes(32)
  const H = sha256(preimage)
  const init = await boltz<{ swapId: string; invoice: string }>('/v2/subdust/atomic/receive/init', {
    amount: a,
    paymentHash: enc(H),
    userPubkey: enc(bridgeXOnly),
  })
  check(!!init.swapId && init.invoice.startsWith('ln'), `/receive/init ok (swap ${init.swapId.slice(0, 8)}…)`)

  // external payer (lnd) pays the hold invoice — held until boltz has the preimage.
  execFileSync('docker', ['exec', '-d', 'lnd', 'lncli', '--network=regtest', 'payinvoice', '--force', init.invoice], { encoding: 'utf8' })
  console.log('external payer (lnd) paying the hold invoice (held)…')

  type Status = { state: string; fundingOutpoint?: string; presigs?: { arkTx: string; checkpoint: string }; refundLocktime?: number }
  let status: Status | undefined
  for (let i = 0; i < 40; i++) {
    const s: Status = await boltzGet(`/v2/subdust/atomic/receive/status?swapId=${init.swapId}`)
    status = s
    if (s.state === 'funded' && s.fundingOutpoint && s.presigs) break
    await sleep(1000)
  }
  check(status?.state === 'funded' && !!status.fundingOutpoint, `boltz funded + presigned (state=${status?.state})`)
  if (!status || !status.fundingOutpoint || !status.presigs || status.refundLocktime === undefined) {
    throw new Error('boltz never funded')
  }
  const { fundingOutpoint, presigs, refundLocktime } = status

  const T = BigInt(refundLocktime)
  const script = new AtomicVtxoScript({ funder: boltzXOnly, claimer: bridgeXOnly, server: serverXOnly, paymentHash: H, refundLocktime: T, exitDelay: d })
  const [txid, voutStr] = fundingOutpoint.split(':')
  if (!txid || voutStr === undefined) throw new Error(`bad funding outpoint ${fundingOutpoint}`)
  const { vtxos } = await indexer.getVtxos({ scripts: [enc(script.pkScript)], spendableOnly: true })
  const v = vtxos.find((x) => x.txid === txid && x.vout === Number(voutStr))
  if (!v) throw new Error('shared vtxo not found')
  const shared: SharedVtxo = { txid, vout: Number(voutStr), value: v.value, script }
  const split = computeClaimSplit({ funderAddress: boltzAddr, claimerAddress: bridgeAddr, fundingValue: v.value, amount: a, dust })
  const claimTxid = await finishClaim(shared, split.outputs, unroll, presigs, bridge, preimage, ark)
  check(!!claimTxid, `bridge claimed a=${a} (arkTx ${claimTxid.slice(0, 12)}…) — preimage revealed, NO settle call`)

  // THE TWIST: we do NOT call /receive/settle. A griefer would withhold it.
  // boltz must harvest the preimage from the claim tx and settle on its own.
  console.log('\nwithholding /receive/settle — waiting for boltz to harvest + auto-settle (≤90s scan)…')
  let settledOnLnd = false
  let swapSettled = false
  for (let i = 0; i < 95 && !(settledOnLnd && swapSettled); i++) {
    await sleep(1000)
    try {
      settledOnLnd = JSON.parse(boltzLnd('lookupinvoice', enc(H))).state === 'SETTLED'
    } catch {
      /* transient */
    }
    try {
      swapSettled = (await boltzGet<Status>(`/v2/subdust/atomic/receive/status?swapId=${init.swapId}`)).state === 'settled'
    } catch {
      /* transient */
    }
    if (i % 10 === 9) console.log(`  … ${i + 1}s (invoice settled=${settledOnLnd}, swap settled=${swapSettled})`)
  }
  check(settledOnLnd, 'boltz auto-SETTLED the hold invoice WITHOUT our settle call (preimage harvested from the claim)')
  check(swapSettled, "swap state reached 'settled' via the harvester")

  // bridge still got its `a` — the receive was atomic for the user too.
  const { vtxos: bv } = await indexer.getVtxos({ scripts: [enc(bridgeAddr.pkScript)], recoverableOnly: true })
  check(bv.some((x) => x.value === a && !x.isSpent), `bridge holds the sub-dust a=${a} (recoverable) — atomic both ways`)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(
    FAIL === 0
      ? '✅ F1 HARVEST WORKS — boltz settled from the on-chain preimage; claim-without-settle steals nothing'
      : '❌ FAILURES — F1 harvester did not settle; a griefer could take `a`',
  )
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
