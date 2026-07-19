// F3 drill (SUBDUST_ATOMIC_SECURITY_REVIEW.md) — concurrent /send/fund.
// Two /send/fund requests are fired simultaneously for the SAME swap + presigs.
// The init->funded CAS must let exactly ONE proceed to pay+claim; the other must
// be rejected (concurrent / not-fundable), so boltz never double-pays the LN
// invoice. Asserts exactly one 'claimed' + one rejection, invoice settled once.
//
// ── Regtest setup (self-contained; the arkade-regtest submodule is UPSTREAM
//    code — do NOT commit config there) ───────────────────────────────────────
// Add to its docker/compose.ark.yml, boltz service, BOLTZ_CONFIG [ark] table
// (revert after the drill):
//     subdustRestUrl   = "http://arkd:7070"
//     subdustSignerKey = "3820bf24c99fd1a1d20205e0237c73af9a0f998b6844aa1e87a09585354abe86"
//     subdustSendWindow    = 86400   # large so this send's cltvLimit stays routable
//     subdustReceiveWindow = 60      # (harmless here; needed by the receive drills)
// Bring the stack up with a long tree-expiry (the 1024 default expires funding
// vtxos mid-drill) and the custom image:
//     ARKD_VTXO_TREE_EXPIRY=7200 BOLTZ_IMAGE=boltz-atomic:regtest node regtest.mjs start --clean --profile boltz
//   bun test/spike/atomic_send_concurrent_e2e.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  ArkAddress,
  DefaultVtxo,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
  type ArkInfo,
} from '@arkade-os/sdk'
import { AtomicVtxoScript, computeClaimSplit, presignClaim, serverUnrollScript } from '../../src/atomic'

const ARKD_URL = process.env.ARKD_URL ?? 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL ?? 'http://localhost:3000/api'
const BOLTZ_URL = process.env.BOLTZ_URL ?? 'http://localhost:9069'
const ARK_PW = process.env.ARKD_PASSWORD ?? 'secret'
const HRP = 'tark'
const enc = (b: Uint8Array) => hex.encode(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))

const REGTEST_DIR = process.env.REGTEST_DIR ?? '/Users/zxcvjklkjasdflk/dev/ark/my-server/reference/arkade-nwc-bridge/regtest-e2e/arkade-regtest'
const regtest = (...a: string[]) => execFileSync('node', ['regtest.mjs', ...a], { cwd: REGTEST_DIR, encoding: 'utf8', maxBuffer: 1e7 })
const lnd = (...a: string[]) => execFileSync('docker', ['exec', 'lnd', 'lncli', '--network=regtest', ...a], { encoding: 'utf8' })

let PASS = 0
let FAIL = 0
const check = (c: boolean, l: string) => { console.log(`  ${c ? '✅' : '❌'} ${l}`); c ? PASS++ : FAIL++ }

type FundRes = { status: string; preimage?: string; error?: string }
// Unlike the other spikes' boltz(), this returns the parsed body OR a rejection
// marker so allSettled can classify both concurrent calls.
async function sendFund(body: unknown): Promise<{ ok: boolean; status: number; body?: FundRes; text?: string }> {
  const res = await fetch(`${BOLTZ_URL}/v2/subdust/atomic/send/fund`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => '') }
  return { ok: true, status: res.status, body: (await res.json()) as FundRes }
}
async function boltzInit<T>(body: unknown): Promise<T> {
  const res = await fetch(`${BOLTZ_URL}/v2/subdust/atomic/send/init`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`init -> ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()) as T
}

async function main(): Promise<void> {
  console.log(`atomic send CONCURRENT-fund drill (F3) — boltz ${BOLTZ_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnrollScript(info.checkpointTapscript)
  const dust = Number(info.dust)
  const a = 21

  const identity = SingleKey.fromPrivateKey(randomBytes(32))
  const wallet = await Wallet.create({
    identity, arkServerUrl: ARKD_URL, esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: { vtxoThreshold: 3600 },
  })
  const userXOnly = toXOnly(await identity.xOnlyPublicKey())
  const address = await wallet.getAddress()
  console.log('funding the funder wallet…')
  regtest('ark', 'send', '--to', address, '--amount', '200000', '--password', ARK_PW)
  regtest('mine', '1')
  for (let i = 0; i < 30 && (await wallet.getBalance()).available < 200000; i++) await sleep(500)
  check((await wallet.getBalance()).available >= 200000, `funder funded (${(await wallet.getBalance()).available})`)

  const invoice = JSON.parse(lnd('addinvoice', '--amt', String(a))).payment_request as string
  const init = await boltzInit<{ swapId: string; boltzPubkey: string; refundLocktime: number; exitDelay: string }>({ invoice, userPubkey: enc(userXOnly) })
  check(!!init.swapId, `/send/init ok (swap ${init.swapId.slice(0, 8)}…)`)
  const boltzXOnly = toXOnly(hex.decode(init.boltzPubkey))
  const T = BigInt(init.refundLocktime)
  const d = BigInt(init.exitDelay)
  const H = hex.decode(JSON.parse(lnd('decodepayreq', invoice)).payment_hash as string)

  // build + fund the shared vtxo (V = a + dust), presign
  const script = new AtomicVtxoScript({ funder: userXOnly, claimer: boltzXOnly, server: serverXOnly, paymentHash: H, refundLocktime: T, exitDelay: d })
  const V = a + dust
  await wallet.sendBitcoin({ address: script.address(HRP, serverXOnly).encode(), amount: V })
  regtest('mine', '1')
  const sharedPk = enc(script.pkScript)
  let shared: { txid: string; vout: number } | undefined
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === V)
    if (v) { shared = { txid: v.txid, vout: v.vout }; break }
    await sleep(500)
  }
  if (!shared) throw new Error('shared vtxo never appeared')
  const funderAddr = ArkAddress.decode(address)
  const tlt = d >= 512n ? ('seconds' as const) : ('blocks' as const)
  const boltzAddr = new DefaultVtxo.Script({ pubKey: boltzXOnly, serverPubKey: serverXOnly, csvTimelock: { type: tlt, value: d } }).address(HRP, serverXOnly)
  const split = computeClaimSplit({ funderAddress: funderAddr, claimerAddress: boltzAddr, fundingValue: V, amount: a, dust })
  const presig = await presignClaim({ ...shared, value: V, script }, split.outputs, unroll, identity)
  check(true, `funded shared vtxo + presigned (V=${V})`)

  // THE TEST: fire two /send/fund SIMULTANEOUSLY for the same swap + presigs.
  console.log('\nfiring TWO concurrent /send/fund for the same swap…')
  const body = { swapId: init.swapId, fundingOutpoint: `${shared.txid}:${shared.vout}`, presigs: presig }
  const [r1, r2] = await Promise.all([sendFund(body), sendFund(body)])
  const results = [r1, r2]
  const claimed = results.filter((r) => r.ok && r.body?.status === 'claimed')
  const rejected = results.filter((r) => !r.ok || r.body?.status !== 'claimed')
  console.log(`  responses: ${results.map((r) => (r.ok ? r.body?.status : `HTTP ${r.status}: ${(r.text ?? '').slice(0, 80)}`)).join(' | ')}`)

  check(claimed.length === 1, `exactly ONE /send/fund claimed (got ${claimed.length})`)
  check(rejected.length === 1, `exactly ONE /send/fund rejected by the CAS (got ${rejected.length})`)
  const preimage = claimed[0]?.body?.preimage
  check(!!preimage && enc(sha256(hex.decode(preimage))) === enc(H), 'the winning claim returned the real preimage')

  // the LN invoice settled exactly once (no double pay)
  regtest('mine', '1')
  let settled = false
  for (let i = 0; i < 12 && !settled; i++) { settled = JSON.parse(lnd('lookupinvoice', enc(H))).state === 'SETTLED'; if (!settled) await sleep(1000) }
  check(settled, 'lnd invoice SETTLED (paid — once; LND would reject a duplicate)')

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0 ? '✅ F3 CAS WORKS — concurrent /send/fund yields exactly one pay+claim, no double pay' : '❌ FAILURES — see above')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => { console.error('\nspike crashed:', e); process.exit(1) })
