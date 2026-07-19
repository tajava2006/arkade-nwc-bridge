// F14 drill (SUBDUST_ATOMIC_SECURITY_REVIEW.md) — recover a receive stuck at
// 'invoice_issued'. The htlc.accepted listener is in-memory, so if onHoldAccepted
// fails (empty mini-wallet) or the process restarts, a PAID + HELD invoice can be
// left with nothing funding it. Before F14 nothing ever retried — the receive
// died silently and the payer was refunded at HTLC timeout. After F14 the
// resumeReceives scan also sweeps 'invoice_issued': it looks up the hold invoice,
// sees ACCEPTED, and (re)funds via onHoldAccepted.
//
// This drill reproduces the real trigger deterministically (independent of the
// mini-wallet balance): RESTART boltz right after minting the invoice, THEN pay
// it. The restarted boltz never subscribed to this invoice's HTLC (the listener
// is in-memory, set only in receiveInit), so nothing funds it on acceptance —
// it sits at 'invoice_issued' with the HTLC held until the resumeReceives scan
// picks it up (F14) and funds it.
//
// ── Regtest setup: same as atomic_receive_harvest_e2e (F1). Auto-miner must be
//    OFF (default for `start`) so blocks don't advance the held HTLC's CLTV. ──
//     ARKD_VTXO_TREE_EXPIRY=7200 BOLTZ_IMAGE=boltz-atomic:regtest node regtest.mjs start --clean --profile boltz
//   bun test/spike/atomic_invoice_issued_resume_e2e.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { hex } from '@scure/base'
import { randomBytes } from '@noble/hashes/utils.js'
import { DefaultVtxo, RestArkProvider, SingleKey, type ArkInfo } from '@arkade-os/sdk'

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
  console.log(`atomic receive INVOICE_ISSUED recovery drill (F14) — boltz ${BOLTZ_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  const a = 21
  const tl = { type: d >= 512n ? ('seconds' as const) : ('blocks' as const), value: d }

  const boltzKey = SingleKey.fromPrivateKey(hex.decode(BOLTZ_KEY))
  const boltzXOnly = toXOnly(await boltzKey.xOnlyPublicKey())
  const boltzAddr = new DefaultVtxo.Script({ pubKey: boltzXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)

  // Ensure boltz can fund once the scan runs (top up its mini-wallet up front —
  // the point of THIS drill is the listener loss, not a funding shortage).
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

  type Status = { state: string; fundingOutpoint?: string }
  // RESTART boltz: the in-memory htlc.accepted listener for this invoice is gone.
  console.log('\nrestarting boltz (drops the in-memory htlc.accepted listener)…')
  execFileSync('docker', ['restart', 'boltz'], { encoding: 'utf8' })
  // Wait for boltz REST to answer again.
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(1000)
    try { await boltzGet<Status>(`/v2/subdust/atomic/receive/status?swapId=${init.swapId}`); up = true } catch { /* still down */ }
  }
  check(up, 'boltz came back up after restart')

  // NOW pay the invoice — the restarted boltz never subscribed to it, so nothing
  // funds it on HTLC acceptance; it must sit at 'invoice_issued' until the scan.
  execFileSync('docker', ['exec', '-d', 'lnd', 'lncli', '--network=regtest', 'payinvoice', '--force', init.invoice], { encoding: 'utf8' })
  console.log('external payer paying the hold invoice AFTER restart (no listener → only the scan can fund it)…')

  // The listener is provably gone (restart), so ANY funding from here is by the
  // resumeReceives scan — that is the F14 recovery. (Log the interim state; not a
  // hard check, since a boot-tick scan may legitimately fund it fast.)
  await sleep(15000)
  const midState = (await boltzGet<Status>(`/v2/subdust/atomic/receive/status?swapId=${init.swapId}`)).state
  console.log(`  interim state 15s after payment: '${midState}' (listener is gone — only the scan can advance it)`)

  console.log('\nwaiting for the invoice_issued scan to (re)fund the held receive (≤~120s)…')
  let funded = false
  for (let i = 0; i < 150 && !funded; i++) {
    await sleep(1000)
    try {
      const s = await boltzGet<Status>(`/v2/subdust/atomic/receive/status?swapId=${init.swapId}`)
      funded = s.state === 'funded' && !!s.fundingOutpoint
    } catch { /* transient */ }
    if (i % 15 === 14) console.log(`  … ${i + 1}s (state polling; funded=${funded})`)
  }
  check(funded, "the invoice_issued scan re-funded the held receive → 'funded' (recovered without a manual re-init)")

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0 ? '✅ F14 WORKS — a paid-but-held receive that failed to fund recovers via the scan' : '❌ FAILURES — see above')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => { console.error('\nspike crashed:', e); process.exit(1) })
