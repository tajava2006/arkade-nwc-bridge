// Spike #01, REWRITTEN over the src/atomic lib (#05 DoD). The original #01
// carried the whole protocol inline to prove the design; now that Phase 1 has
// formalized it (script.ts / split.ts / tx.ts), this same regtest round-trip
// must stay green driving the LIB — that's the #05 acceptance ("#01 PoC를 이
// lib로 재작성해 green"). If this passes, the lib faithfully reproduces the
// arkd-accepted flow and the inline spike is retired.
//
// Covers (all against a live regtest arkd, seconds mode — CLTV refund):
//   (i)   F offline, C claims via F's 2 presigs — regular change (a=21) and
//         sub-dust change (a=200, 2 OP_RETURN)
//   (ii)  CLTV refund: T elapsed accepted, T future rejected
//   (iii) F+C+server cooperative cancel
//
//   regtest-e2e/up.sh  (or reference/ts-sdk/regtest in seconds mode)
//   bun test/spike/atomic_poc.spike.ts
//
// polyfills first (bun async-ESM require trap), as every entrypoint does.

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  ArkAddress,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
  type ArkInfo,
} from '@arkade-os/sdk'
import {
  AtomicVtxoScript,
  cancelSpend,
  computeClaimSplit,
  finishClaim,
  presignClaim,
  refundSpend,
  serverUnrollScript,
  type AtomicOutput,
  type SharedVtxo,
} from '../../src/atomic'

const ARKD_URL = process.env.ARKD_URL ?? 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL ?? 'http://localhost:3000/api'
const ARK_PW = process.env.ARKD_PASSWORD ?? 'secret'
const HRP = 'tark'
const enc = (b: Uint8Array) => hex.encode(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))

function resolveRegtestDir(): string {
  if (process.env.REGTEST_DIR) return process.env.REGTEST_DIR
  const root = join(import.meta.dir, '../..')
  for (const c of [
    join(root, 'regtest-e2e/arkade-regtest'),
    join(root, '../ts-sdk/regtest'),
    join(root, '../../../ts-sdk/regtest'),
  ])
    if (existsSync(join(c, 'regtest.mjs'))) return c
  throw new Error('arkade-regtest not found — set REGTEST_DIR')
}
const REGTEST_DIR = resolveRegtestDir()
const regtest = (...args: string[]) =>
  execFileSync('node', ['regtest.mjs', ...args], { cwd: REGTEST_DIR, encoding: 'utf8', maxBuffer: 1e7 })

let PASS = 0
let FAIL = 0
const check = (cond: boolean, label: string) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`)
  cond ? PASS++ : FAIL++
}

async function newWallet(): Promise<{ wallet: Wallet; identity: SingleKey; xonly: Uint8Array; address: string }> {
  const identity = SingleKey.fromPrivateKey(randomBytes(32))
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARKD_URL,
    esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: { vtxoThreshold: 3600 },
  })
  return { wallet, identity, xonly: toXOnly(await identity.xOnlyPublicKey()), address: await wallet.getAddress() }
}

async function fundShared(
  funder: Wallet,
  indexer: RestIndexerProvider,
  script: AtomicVtxoScript,
  serverXOnly: Uint8Array,
  value: number,
): Promise<SharedVtxo> {
  const address = script.address(HRP, serverXOnly).encode()
  const pk = enc(script.pkScript)
  await funder.sendBitcoin({ address, amount: value })
  regtest('mine', '1')
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [pk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === value)
    if (v) return { txid: v.txid, vout: v.vout, value: v.value, script }
    await sleep(500)
  }
  throw new Error(`shared vtxo (value=${value}) never appeared`)
}

async function claimerGotSubdust(indexer: RestIndexerProvider, claimerAddr: ArkAddress, a: number): Promise<boolean> {
  const pk = enc(claimerAddr.pkScript)
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [pk], recoverableOnly: true })
    if (vtxos.some((v) => v.value === a && !v.isSpent)) return true
    await sleep(500)
  }
  return false
}

async function main(): Promise<void> {
  console.log(`atomic sub-dust PoC (#01 over the lib, #05) — arkd ${ARKD_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnrollScript(info.checkpointTapscript)
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  const nowSecs = () => BigInt(Math.floor(Date.now() / 1000))
  const a = Math.max(Number(info.vtxoMinAmount), 21)
  console.log(`params: dust=${dust} vtxoMin=${info.vtxoMinAmount} d=${d} a=${a} net=${info.network}\n`)

  const F = await newWallet()
  const C = await newWallet()
  const funderAddr = ArkAddress.decode(F.address)
  const claimerAddr = ArkAddress.decode(C.address)
  console.log('funding F wallet with 200000 sats…')
  regtest('ark', 'send', '--to', F.address, '--amount', '200000', '--password', ARK_PW)
  regtest('mine', '1')
  for (let i = 0; i < 30 && (await F.wallet.getBalance()).available < 200000; i++) await sleep(500)
  check((await F.wallet.getBalance()).available >= 200000, `F funded (${(await F.wallet.getBalance()).available})`)

  const mkScript = (paymentHash: Uint8Array, T: bigint) =>
    new AtomicVtxoScript({ funder: F.xonly, claimer: C.xonly, server: serverXOnly, paymentHash, refundLocktime: T, exitDelay: d })
  const fullToFunder = (V: number): AtomicOutput[] => [{ script: funderAddr.pkScript, amount: BigInt(V) }]

  // ---- (i-A) claim, regular change ----
  console.log('\n(i-A) claim, regular change (F offline after presign):')
  {
    const preimage = randomBytes(32)
    const script = mkScript(sha256(preimage), nowSecs() + 3600n)
    const V = 1000
    const shared = await fundShared(F.wallet, indexer, script, serverXOnly, V)
    const split = computeClaimSplit({ funderAddress: funderAddr, claimerAddress: claimerAddr, fundingValue: V, amount: a, dust })
    check(split.opReturns === 1 && split.changeKind === 'regular', `split: 1 OP_RETURN, regular change ${split.changeAmount}`)
    const presig = await presignClaim(shared, split.outputs, unroll, F.identity)
    const txid = await finishClaim(shared, split.outputs, unroll, presig, C.identity, preimage, ark)
    check(!!txid, `lib claim finished (arkTxid ${txid.slice(0, 12)}…)`)
    check(await claimerGotSubdust(indexer, claimerAddr, a), `C received sub-dust a=${a}`)
  }

  // ---- (i-B) claim, sub-dust change (2 OP_RETURN) ----
  console.log('\n(i-B) claim, sub-dust change (2 OP_RETURN):')
  {
    const preimage = randomBytes(32)
    const script = mkScript(sha256(preimage), nowSecs() + 3600n)
    const aB = dust - 130
    const V = aB + (dust - 130)
    const shared = await fundShared(F.wallet, indexer, script, serverXOnly, V)
    const split = computeClaimSplit({ funderAddress: funderAddr, claimerAddress: claimerAddr, fundingValue: V, amount: aB, dust })
    check(split.opReturns === 2 && split.changeKind === 'subdust', `split: 2 OP_RETURN, sub-dust change ${split.changeAmount}`)
    const presig = await presignClaim(shared, split.outputs, unroll, F.identity)
    const txid = await finishClaim(shared, split.outputs, unroll, presig, C.identity, preimage, ark)
    check(!!txid, `lib claim (2 OP_RETURN) finished (arkTxid ${txid.slice(0, 12)}…)`)
    check(await claimerGotSubdust(indexer, claimerAddr, aB), `C received sub-dust a=${aB}`)
  }

  // ---- (ii) refund ----
  console.log('\n(ii) CLTV refund:')
  {
    const script = mkScript(sha256(randomBytes(32)), nowSecs() - 3600n) // elapsed T
    const V = 1000
    const shared = await fundShared(F.wallet, indexer, script, serverXOnly, V)
    regtest('mine', '1') // advance MTP past the elapsed T
    try {
      const txid = await refundSpend(shared, fullToFunder(V), unroll, F.identity, ark)
      check(!!txid, `refund after elapsed T accepted (arkTxid ${txid.slice(0, 12)}…)`)
    } catch (e) {
      check(false, `refund after elapsed T: ${e instanceof Error ? e.message : e}`)
    }
  }
  {
    const script = mkScript(sha256(randomBytes(32)), nowSecs() + 100_000n) // future T
    const V = 1000
    const shared = await fundShared(F.wallet, indexer, script, serverXOnly, V)
    let rejected = false
    try {
      await refundSpend(shared, fullToFunder(V), unroll, F.identity, ark)
    } catch {
      rejected = true
    }
    check(rejected, 'refund before T is rejected by arkd (CLTV enforced)')
  }

  // ---- (iii) cancel ----
  console.log('\n(iii) cooperative cancel:')
  {
    const script = mkScript(sha256(randomBytes(32)), nowSecs() + 3600n)
    const V = 1000
    const shared = await fundShared(F.wallet, indexer, script, serverXOnly, V)
    try {
      const txid = await cancelSpend(shared, fullToFunder(V), unroll, F.identity, C.identity, ark)
      check(!!txid, `cancel (F+C+server) accepted (arkTxid ${txid.slice(0, 12)}…)`)
    } catch (e) {
      check(false, `cancel: ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(
    FAIL === 0
      ? '✅ #01 round-trip GREEN over the src/atomic lib — #05 lib faithfully reproduces the flow'
      : '❌ FAILURES — the lib diverges from the arkd-accepted flow',
  )
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
