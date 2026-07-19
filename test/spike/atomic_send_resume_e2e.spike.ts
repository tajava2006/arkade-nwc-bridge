// F6 drill (SUBDUST_ATOMIC_SECURITY_REVIEW.md) — send claim RESUME.
// Reproduces the "boltz paid the LN invoice but its claim didn't land" state
// (e.g. arkd blipped during finishClaim) deterministically: set up + presign as
// usual, pay the invoice from boltz-lnd directly, then mark the boltz swap
// 'ln_inflight' (paid, unclaimed) via its DB. boltz's resumeSends scan must then
// recover the preimage from boltz-lnd (trackPayment) and complete the claim on
// its own — no operator help, no lost `a`.
//
// ── Regtest setup (self-contained; the arkade-regtest submodule is UPSTREAM
//    code — do NOT commit config there) ───────────────────────────────────────
// Add to its docker/compose.ark.yml, boltz service, BOLTZ_CONFIG [ark] table
// (revert after the drill):
//     subdustRestUrl   = "http://arkd:7070"
//     subdustSignerKey = "3820bf24c99fd1a1d20205e0237c73af9a0f998b6844aa1e87a09585354abe86"  # = BOLTZ_KEY below
//     subdustSendWindow    = 86400   # large so the send's cltvLimit stays routable
//     subdustReceiveWindow = 60      # (harmless here; needed by the receive drills)
// Bring the stack up with a long tree-expiry (the 1024 default expires funding
// vtxos mid-drill) and the custom image:
//     ARKD_VTXO_TREE_EXPIRY=7200 BOLTZ_IMAGE=boltz-atomic:regtest node regtest.mjs start --clean --profile boltz
// This drill also writes the boltz DB directly (docker exec postgres psql -U
// postgres -d boltz) to inject the paid-but-unclaimed 'ln_inflight' state.
//   bun test/spike/atomic_send_resume_e2e.spike.ts

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
const boltzLnd = (...a: string[]) => execFileSync('docker', ['exec', 'boltz-lnd', 'lncli', '--network=regtest', ...a], { encoding: 'utf8' })
const psql = (sql: string) => execFileSync('docker', ['exec', 'postgres', 'psql', '-U', 'postgres', '-d', 'boltz', '-c', sql], { encoding: 'utf8' })

let PASS = 0
let FAIL = 0
const check = (c: boolean, l: string) => { console.log(`  ${c ? '✅' : '❌'} ${l}`); c ? PASS++ : FAIL++ }
async function boltzInit<T>(body: unknown): Promise<T> {
  const res = await fetch(`${BOLTZ_URL}/v2/subdust/atomic/send/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`init -> ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()) as T
}
async function status(swapId: string): Promise<{ state: string; preimage?: string }> {
  const res = await fetch(`${BOLTZ_URL}/v2/subdust/atomic/send/status?swapId=${swapId}`)
  return (await res.json()) as { state: string; preimage?: string }
}

async function main(): Promise<void> {
  console.log(`atomic send RESUME drill (F6) — boltz ${BOLTZ_URL}\n`)
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
  const boltzXOnly = toXOnly(hex.decode(init.boltzPubkey))
  const T = BigInt(init.refundLocktime)
  const d = BigInt(init.exitDelay)
  const H = hex.decode(JSON.parse(lnd('decodepayreq', invoice)).payment_hash as string)
  check(!!init.swapId, `/send/init ok (swap ${init.swapId.slice(0, 8)}…)`)

  // fund shared vtxo + presign
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

  // Reproduce the stuck state: pay the invoice from boltz-lnd (so the preimage
  // lives there, exactly as after boltz's own sendPayment), then mark the swap
  // 'ln_inflight' with the presigs + funding — i.e. "paid, claim not yet landed".
  console.log('\npaying the invoice from boltz-lnd (as boltz would), then marking the swap ln_inflight…')
  boltzLnd('payinvoice', '--force', invoice)
  check(JSON.parse(lnd('lookupinvoice', enc(H))).state === 'SETTLED', 'invoice paid by boltz-lnd (preimage now recoverable via trackPayment)')
  const outpoint = `${shared.txid}:${shared.vout}`
  psql(`UPDATE "subdustAtomicSwaps" SET state='ln_inflight', presigs='${JSON.stringify(presig)}', "fundingOutpoint"='${outpoint}' WHERE id='${init.swapId}'`)
  check((await status(init.swapId)).state === 'ln_inflight', "swap is stuck at 'ln_inflight' (paid, unclaimed)")

  // boltz's resumeSends (60s scan) must now claim on its own.
  console.log('\nwaiting for boltz resumeSends to recover the claim (≤90s scan)…')
  let claimed = false
  let vtxoSpent = false
  for (let i = 0; i < 95 && !(claimed && vtxoSpent); i++) {
    await sleep(1000)
    try { claimed = (await status(init.swapId)).state === 'claimed' } catch { /* */ }
    try { vtxoSpent = !(await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })).vtxos.some((x) => x.txid === shared!.txid && x.vout === shared!.vout) } catch { /* */ }
    if (i % 15 === 14) console.log(`  … ${i + 1}s (claimed=${claimed}, vtxoSpent=${vtxoSpent})`)
  }
  const st = await status(init.swapId)
  check(claimed, "swap state reached 'claimed' via resumeSends (no operator help)")
  check(vtxoSpent, 'boltz claimed its `a` from the shared vtxo (funding consumed)')
  check(!!st.preimage && enc(sha256(hex.decode(st.preimage))) === enc(H), 'recovered preimage matches the invoice payment hash')

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0 ? '✅ F6 SEND-RESUME WORKS — a paid-but-unclaimed send is auto-recovered; boltz never eats `a`' : '❌ FAILURES — see above')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => { console.error('\nspike crashed:', e); process.exit(1) })
