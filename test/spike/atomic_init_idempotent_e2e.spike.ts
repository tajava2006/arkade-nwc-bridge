// F17 + F10 drill (SUBDUST_ATOMIC_SECURITY_REVIEW.md).
//
//   F17 — init idempotency: a second /receive/init (same payment hash) or
//         /send/init (same invoice) for a swap that never funded must hand back
//         the SAME swap (same swapId, and for receive the SAME hold invoice —
//         no duplicate mint), not a permanent dedup error. So a client that
//         failed between init and funding can retry the same invoice.
//   F10 — the receive hold invoice's final CLTV must be sized to the receive
//         window (⌈window/blockTime⌉ + buffer), NOT LND's tiny default — else
//         the held HTLC is auto-cancelled long before the window and a late
//         claim leaves boltz unable to settle.
//
// Pure init-level checks: no LN payment, no channels, no claim — fast + robust.
//
// ── Regtest setup (self-contained; arkade-regtest submodule is UPSTREAM code —
//    do NOT commit config there) ────────────────────────────────────────────
// docker/compose.ark.yml, boltz service, BOLTZ_CONFIG [ark] table:
//     subdustRestUrl   = "http://arkd:7070"
//     subdustSignerKey = "3820bf24c99fd1a1d20205e0237c73af9a0f998b6844aa1e87a09585354abe86"
//     subdustReceiveWindow = 60
//     subdustBlockTime     = 30
// Bring up (long tree-expiry + custom image):
//     ARKD_VTXO_TREE_EXPIRY=7200 BOLTZ_IMAGE=boltz-atomic:regtest node regtest.mjs start --clean --profile boltz
//   bun test/spike/atomic_init_idempotent_e2e.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { hex } from '@scure/base'
import { randomBytes } from '@noble/hashes/utils.js'
import { RestArkProvider, SingleKey, type ArkInfo } from '@arkade-os/sdk'

const ARKD_URL = process.env.ARKD_URL ?? 'http://localhost:7070'
const BOLTZ_URL = process.env.BOLTZ_URL ?? 'http://localhost:9069'

// Must match the compose BOLTZ_CONFIG [ark] values above (F10 expected CLTV).
const RECEIVE_WINDOW = Number(process.env.SUBDUST_RECEIVE_WINDOW ?? 60)
const BLOCK_TIME = Number(process.env.SUBDUST_BLOCK_TIME ?? 30)
const CLTV_BUFFER_BLOCKS = 18 // SUBDUST_RECEIVE_CLTV_BUFFER_BLOCKS in the router

const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))
const enc = (b: Uint8Array) => hex.encode(b)
const sha256 = (b: Uint8Array) => Uint8Array.from(createHash('sha256').update(b).digest())
const lnd = (...a: string[]) =>
  execFileSync('docker', ['exec', 'lnd', 'lncli', '--network=regtest', ...a], { encoding: 'utf8' })
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

async function main(): Promise<void> {
  console.log(`atomic init IDEMPOTENCY + CLTV drill (F17 + F10) — boltz ${BOLTZ_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const dust = Number(info.dust)
  const a = 21
  if (a >= dust) throw new Error(`a=${a} is not sub-dust (dust ${dust})`)

  const user = SingleKey.fromPrivateKey(randomBytes(32))
  const userXOnly = toXOnly(await user.xOnlyPublicKey())

  // ── F17 receive: same payment hash twice → same swap + same invoice ────────
  console.log('F17 receive: two /receive/init with the SAME payment hash…')
  const preimage = randomBytes(32)
  const H = sha256(preimage)
  const r1 = await boltz<{ swapId: string; invoice: string }>('/v2/subdust/atomic/receive/init', {
    amount: a,
    paymentHash: enc(H),
    userPubkey: enc(userXOnly),
  })
  const r2 = await boltz<{ swapId: string; invoice: string }>('/v2/subdust/atomic/receive/init', {
    amount: a,
    paymentHash: enc(H),
    userPubkey: enc(userXOnly),
  })
  check(r1.swapId === r2.swapId, `same swapId returned (${r1.swapId.slice(0, 8)}… == ${r2.swapId.slice(0, 8)}…)`)
  check(r1.invoice === r2.invoice, 'same hold invoice returned — no duplicate mint')

  // ── F10: the receive hold invoice's final CLTV covers the window ───────────
  console.log('\nF10: decode the hold invoice, check its final CLTV…')
  const decoded = JSON.parse(boltzLnd('decodepayreq', r1.invoice)) as { cltv_expiry?: number | string }
  const cltv = Number(decoded.cltv_expiry)
  const expected = Math.ceil(RECEIVE_WINDOW / BLOCK_TIME) + CLTV_BUFFER_BLOCKS
  const windowBlocks = Math.ceil(RECEIVE_WINDOW / BLOCK_TIME)
  console.log(`  invoice cltv_expiry=${cltv}, expected=${expected} (⌈${RECEIVE_WINDOW}/${BLOCK_TIME}⌉ + ${CLTV_BUFFER_BLOCKS})`)
  check(cltv === expected, `final CLTV == ⌈window/blockTime⌉ + buffer (${cltv} == ${expected}) — derived from the window, not LND's default`)
  check(cltv >= windowBlocks, `final CLTV (${cltv}) covers the window (${windowBlocks} blocks) — HTLC outlives T`)

  // ── F17 send: same invoice twice → same swap ───────────────────────────────
  console.log('\nF17 send: two /send/init with the SAME sub-dust invoice…')
  const invoice = JSON.parse(lnd('addinvoice', '--amt', String(a))).payment_request as string
  const s1 = await boltz<{ swapId: string }>('/v2/subdust/atomic/send/init', { invoice, userPubkey: enc(userXOnly) })
  const s2 = await boltz<{ swapId: string }>('/v2/subdust/atomic/send/init', { invoice, userPubkey: enc(userXOnly) })
  check(s1.swapId === s2.swapId, `same swapId returned (${s1.swapId.slice(0, 8)}… == ${s2.swapId.slice(0, 8)}…)`)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(
    FAIL === 0
      ? '✅ F17 + F10 WORK — init is idempotent for unfunded swaps; the hold invoice CLTV tracks the window'
      : '❌ FAILURES — see above',
  )
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
