// #14 drill — the boltz atomic RECEIVE path (LN→ARK), first runtime.
// bridge (this script, as CLAIMER C, empty wallet) ↔ custom boltz (funder F) ↔
// regtest arkd + LN. boltz mints a HOLD invoice; the external payer (lnd) pays
// it (held); boltz funds a shared vtxo + pre-signs; the bridge claims with the
// preimage; boltz settles the hold invoice.
//
//   arkade-regtest up --profile boltz (seconds mode) with BOLTZ_IMAGE=boltz-atomic:regtest
//   bun test/spike/atomic_receive_e2e.spike.ts

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
// The drill's boltz signer key (matches compose.ark.yml subdustSignerKey). Used
// only to derive + fund boltz's mini-wallet — a setup step, not the protocol.
const BOLTZ_KEY = '3820bf24c99fd1a1d20205e0237c73af9a0f998b6844aa1e87a09585354abe86'
const HRP = 'tark'
const enc = (b: Uint8Array) => hex.encode(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))
const sha256 = (b: Uint8Array) => Uint8Array.from(createHash('sha256').update(b).digest())

const REGTEST_DIR = process.env.REGTEST_DIR ?? '/Users/zxcvjklkjasdflk/dev/ark/my-server/reference/ts-sdk/regtest'
const regtest = (...a: string[]) =>
  execFileSync('node', ['regtest.mjs', ...a], { cwd: REGTEST_DIR, encoding: 'utf8', maxBuffer: 1e7 })
const lnd = (...a: string[]) =>
  execFileSync('docker', ['exec', 'lnd', 'lncli', '--network=regtest', ...a], { encoding: 'utf8' })
// The hold invoice lives on boltz's own node (boltz-lnd), which the external
// payer (lnd) pays — so look the invoice up there, not on lnd.
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
  console.log(`atomic receive e2e (#14) — boltz ${BOLTZ_URL}, arkd ${ARKD_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnrollScript(info.checkpointTapscript)
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  const a = 21
  const tl = { type: d >= 512n ? ('seconds' as const) : ('blocks' as const), value: d }

  // Setup: fund boltz's mini-wallet (boltz = funder on receive).
  const boltzKey = SingleKey.fromPrivateKey(hex.decode(BOLTZ_KEY))
  const boltzXOnly = toXOnly(await boltzKey.xOnlyPublicKey())
  const boltzAddr = new DefaultVtxo.Script({ pubKey: boltzXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)
  console.log('funding boltz mini-wallet…')
  regtest('ark', 'send', '--to', boltzAddr.encode(), '--amount', '100000', '--password', ARK_PW)
  regtest('mine', '1')
  await sleep(1500)

  // bridge = claimer C (empty wallet — just a key).
  const bridge = SingleKey.fromPrivateKey(randomBytes(32))
  const bridgeXOnly = toXOnly(await bridge.xOnlyPublicKey())
  const bridgeAddr = new DefaultVtxo.Script({ pubKey: bridgeXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)

  // 1. bridge generates the preimage; boltz mints a hold invoice for H.
  const preimage = randomBytes(32)
  const H = sha256(preimage)
  const init = await boltz<{ swapId: string; invoice: string }>('/v2/subdust/atomic/receive/init', {
    amount: a,
    paymentHash: enc(H),
    userPubkey: enc(bridgeXOnly),
  })
  check(!!init.swapId && init.invoice.startsWith('ln'), `/receive/init ok (swap ${init.swapId.slice(0, 8)}…, hold invoice minted)`)

  // 2. external payer (lnd) pays the hold invoice — stays IN-FLIGHT (accepted,
  // not settled) until boltz has the preimage. Detach so it doesn't block.
  execFileSync('docker', ['exec', '-d', 'lnd', 'lncli', '--network=regtest', 'payinvoice', '--force', init.invoice], { encoding: 'utf8' })
  console.log('external payer (lnd) paying the hold invoice (held)…')

  // 3. boltz funds + pre-signs on htlc.accepted → poll status until funded.
  type Status = { state: string; fundingOutpoint?: string; presigs?: { arkTx: string; checkpoint: string }; refundLocktime?: number; exitDelay?: string }
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

  // 4. bridge rebuilds the shared vtxo + verifies + claims (reveals the preimage).
  const T = BigInt(refundLocktime)
  const script = new AtomicVtxoScript({ funder: boltzXOnly, claimer: bridgeXOnly, server: serverXOnly, paymentHash: H, refundLocktime: T, exitDelay: d })
  const [txid, voutStr] = fundingOutpoint.split(':')
  if (!txid || voutStr === undefined) throw new Error(`bad funding outpoint ${fundingOutpoint}`)
  const sharedPk = enc(script.pkScript)
  const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
  const v = vtxos.find((x) => x.txid === txid && x.vout === Number(voutStr))
  check(!!v, `bridge located the shared vtxo it will claim (V=${v?.value})`)
  if (!v) throw new Error('shared vtxo not found')
  const shared: SharedVtxo = { txid, vout: Number(voutStr), value: v.value, script }
  const split = computeClaimSplit({ funderAddress: boltzAddr, claimerAddress: bridgeAddr, fundingValue: v.value, amount: a, dust })
  const claimTxid = await finishClaim(shared, split.outputs, unroll, presigs, bridge, preimage, ark)
  check(!!claimTxid, `bridge claimed a=${a} (arkTx ${claimTxid.slice(0, 12)}…) — preimage revealed`)

  // 5. bridge tells boltz the preimage → boltz settles the hold invoice.
  const settle = await boltz<{ settled: boolean }>('/v2/subdust/atomic/receive/settle', { swapId: init.swapId, preimage: enc(preimage) })
  check(settle.settled === true, 'boltz settled the hold invoice')

  // 6. verify: bridge owns the sub-dust a (recoverable), invoice SETTLED on lnd.
  const bridgePk = enc(bridgeAddr.pkScript)
  let got = false
  for (let i = 0; i < 20 && !got; i++) {
    const { vtxos: bv } = await indexer.getVtxos({ scripts: [bridgePk], recoverableOnly: true })
    got = bv.some((x) => x.value === a && !x.isSpent)
    if (!got) await sleep(500)
  }
  check(got, `bridge received the sub-dust a=${a} (recoverable vtxo)`)
  const settled = JSON.parse(boltzLnd("lookupinvoice", enc(H))).state === 'SETTLED'
  check(settled, 'hold invoice SETTLED on boltz-lnd (external payer paid)')

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(
    FAIL === 0
      ? '✅ ATOMIC RECEIVE WORKS END-TO-END — empty-wallet bridge received 21 sats atomically over LN'
      : '❌ FAILURES — see above',
  )
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
