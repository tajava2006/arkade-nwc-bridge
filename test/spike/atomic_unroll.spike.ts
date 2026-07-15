// Spike #02 (ATOMIC_SUBDUST_PLAN.md §6) — the FUNDER's unilateral exit path.
//
// #01 proved the cooperative paths (claim/refund/cancel). #02 proves F's
// ASP-free escape hatch: if the swap stalls and the ASP won't co-sign, F can
// still recover the FULL shared V by unrolling the shared vtxo onchain and
// sweeping it via leaf 4 (uexit = CSVMultisig[F], plan §3.1). This is what puts
// an in-progress send's shared vtxo safely in the proof vault (#13).
//
//   fund shared V (offchain) → Unroll.Session drives the chain onchain (CPFP via
//   F's onchain wallet) → wait CSV d → sweep V via uexit leaf to F's P2TR.
//
// Also records the design fact that the CLAIMER has NO unilateral path: the
// only value C could unilaterally realize is the sub-dust `a`, which onchain is
// an OP_RETURN (burned) — so C never broadcasts, and mid-swap unroll theft is
// bounded by ≤ a (plan §1.5). Nothing to execute; asserted structurally.
//
// Runs in BLOCK mode (ts-sdk .env.regtest default: CSV = 20 blocks, `mine 20`
// elapses it instantly). #02 uses no CLTV, so block mode is the right tool —
// the exit-drill RUNBOOK offers exactly this for single-VTXO smoke.
//
//   REGTEST default (block mode):  reference/ts-sdk/regtest → node regtest.mjs start --profile ark
//   bun test/spike/atomic_unroll.spike.ts
//
// polyfills first (bun async-ESM require trap), same as every entrypoint.

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hex } from '@scure/base'
import { Script } from '@scure/btc-signer'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  ArkAddress,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  ConditionMultisigTapscript,
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MultisigTapscript,
  OnchainWallet,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  timelockToSequence,
  Transaction,
  Unroll,
  VtxoScript,
  Wallet,
  type ArkInfo,
  type TapLeafScript,
} from '@arkade-os/sdk'

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
function regtest(...args: string[]): string {
  return execFileSync('node', ['regtest.mjs', ...args], {
    cwd: REGTEST_DIR,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
}

let PASS = 0
let FAIL = 0
function check(cond: boolean, label: string): void {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`)
  cond ? PASS++ : FAIL++
}

// Same 4-leaf script as #01 (duplicated here; #04 formalizes it in src/atomic).
class AtomicSubdustScript extends VtxoScript {
  readonly uexitScript: string
  constructor(
    funder: Uint8Array,
    claimer: Uint8Array,
    server: Uint8Array,
    paymentHash: Uint8Array,
    refundLocktime: bigint,
    exitDelay: bigint,
  ) {
    const conditionScript = Script.encode(['HASH160', ripemd160(paymentHash), 'EQUAL'])
    const claim = ConditionMultisigTapscript.encode({
      conditionScript,
      pubkeys: [funder, claimer, server],
    }).script
    const refund = CLTVMultisigTapscript.encode({
      absoluteTimelock: refundLocktime,
      pubkeys: [funder, server],
    }).script
    const cancel = MultisigTapscript.encode({ pubkeys: [funder, claimer, server] }).script
    const uexit = CSVMultisigTapscript.encode({
      timelock: { type: exitDelay >= 512n ? 'seconds' : 'blocks', value: exitDelay },
      pubkeys: [funder],
    }).script
    super([claim, refund, cancel, uexit])
    this.uexitScript = enc(uexit)
  }
  uexit(): TapLeafScript {
    return this.findLeaf(this.uexitScript)
  }
}

async function newArkWallet(): Promise<{ wallet: Wallet; identity: SingleKey; xonly: Uint8Array; address: string }> {
  const identity = SingleKey.fromPrivateKey(randomBytes(32))
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARKD_URL,
    esploraUrl: ESPLORA_URL,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlementConfig: { vtxoThreshold: 3600 },
  })
  return { wallet, identity, xonly: toXOnly(await identity.xOnlyPublicKey()), address: await wallet.getAddress() }
}

async function main(): Promise<void> {
  console.log(`atomic sub-dust unroll PoC (#02) — arkd ${ARKD_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const esplora = new EsploraProvider(ESPLORA_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript))
  const d = info.unilateralExitDelay
  const dType = d >= 512n ? 'seconds' : 'blocks'
  console.log(`§2.4/§8 params: dust=${info.dust} unilateralExitDelay(d)=${d} (${dType}) network=${info.network}`)
  if (dType !== 'blocks') {
    console.log('  ⚠ d is in SECONDS — CSV needs ~real time to elapse. Restart regtest in block mode for #02.')
  }

  const F = await newArkWallet()
  const Ckey = SingleKey.fromPrivateKey(randomBytes(32)) // claimer: only its pubkey is needed
  const Cxonly = toXOnly(await Ckey.xOnlyPublicKey())
  const fOnchain = await OnchainWallet.create(F.identity, 'regtest', esplora)
  console.log(`\nF ark address:     ${F.address.slice(0, 24)}…`)
  console.log(`F onchain P2TR:    ${fOnchain.address}`)

  // Fund F offchain (for the shared funding) and onchain (to CPFP the unroll).
  console.log('\nfunding F: 200000 sats offchain + 0.01 BTC onchain…')
  regtest('ark', 'send', '--to', F.address, '--amount', '200000', '--password', ARK_PW) // sats
  regtest('mine', '1')
  regtest('faucet', fOnchain.address, '0.01') // faucet unit is BTC → ~1,000,000 sats
  regtest('mine', '1')
  // Authoritative offchain check via the indexer (Wallet.getBalance() lags its
  // ContractManager sync on a fresh in-memory boot).
  const fPk = enc(ArkAddress.decode(F.address).pkScript)
  const fOffchain = async () =>
    (await indexer.getVtxos({ scripts: [fPk], spendableOnly: true })).vtxos.reduce((s, v) => s + v.value, 0)
  for (let i = 0; i < 40 && (await fOffchain()) < 200000; i++) await sleep(500)
  for (let i = 0; i < 20 && (await fOnchain.getBalance()) < 500000; i++) await sleep(500)
  check((await fOffchain()) >= 200000, `F offchain funded (${await fOffchain()} sats)`)
  check((await fOnchain.getBalance()) >= 500000, `F onchain funded (${await fOnchain.getBalance()} sats)`)

  // Build + fund the shared 4-leaf vtxo (V, full amount — no claim happens; F escapes it).
  const preimage = randomBytes(32)
  const script = new AtomicSubdustScript(F.xonly, Cxonly, serverXOnly, sha256(preimage), BigInt(Math.floor(Date.now() / 1000)) + 3600n, d)
  const sharedAddress = script.address(HRP, serverXOnly).encode()
  const sharedPk = enc(script.pkScript)
  const V = 10000
  console.log(`\nfunding shared 4-leaf vtxo V=${V}…`)
  await F.wallet.sendBitcoin({ address: sharedAddress, amount: V })
  regtest('mine', '1')
  let shared: { txid: string; vout: number; value: number } | undefined
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === V)
    if (v) {
      shared = { txid: v.txid, vout: v.vout, value: v.value }
      break
    }
    await sleep(500)
  }
  if (!shared) throw new Error('shared vtxo never appeared')
  check(true, `shared vtxo created ${shared.txid.slice(0, 12)}…:${shared.vout}`)

  // ---- unroll the shared vtxo onchain (reuse the SDK exit machine) ----
  console.log('\nunrolling shared vtxo onchain (CPFP via F onchain wallet)…')
  const session = await Unroll.Session.create({ txid: shared.txid, vout: shared.vout }, fOnchain, esplora, indexer)
  // Drive manually: next() already broadcasts the 1C1P package via bumpP2A, so we
  // mine to confirm and loop — never call step.do() (avoids a double-broadcast).
  let done = false
  for (let i = 0; i < 40 && !done; i++) {
    const step = await session.next()
    switch (step.type) {
      case Unroll.StepType.DONE:
        done = true
        break
      case Unroll.StepType.UNROLL:
        console.log(`  UNROLL ${step.tx.id.slice(0, 12)}… (broadcast package, mining)`)
        regtest('mine', '1')
        await sleep(1200)
        break
      case Unroll.StepType.WAIT:
        console.log(`  WAIT ${step.txid.slice(0, 12)}… (mining to confirm)`)
        regtest('mine', '1')
        await sleep(1200)
        break
    }
  }
  check(done, 'unroll reached DONE (shared vtxo fully onchain)')

  // shared output must now be a confirmed onchain UTXO
  let sharedConf: { confirmed: true; blockHeight: number } | undefined
  for (let i = 0; i < 20; i++) {
    const st = await esplora.getTxStatus(shared.txid)
    if (st.confirmed) {
      sharedConf = st
      break
    }
    regtest('mine', '1')
    await sleep(1000)
  }
  check(!!sharedConf, `shared output confirmed onchain (height ${sharedConf?.blockHeight})`)

  // ---- elapse CSV d, then sweep V via uexit leaf ----
  console.log(`\nelapsing CSV d=${d} ${dType} and sweeping via uexit leaf…`)
  if (dType === 'blocks') {
    regtest('mine', String(Number(d) + 2))
  } else {
    // seconds mode fallback: block-time must advance d seconds (auto-miner)
    console.log(`  waiting ~${Number(d)}s for MTP to pass the CSV…`)
    await sleep((Number(d) + 30) * 1000)
  }

  const sweep = new Transaction({ version: 2 })
  sweep.addInput({
    txid: shared.txid,
    index: shared.vout,
    witnessUtxo: { amount: BigInt(V), script: script.pkScript },
    tapLeafScript: [script.uexit()],
    sequence: timelockToSequence({ type: dType, value: d }),
  })
  const fee = 1000n // flat regtest fee (feeRate ~1); V−fee ≥ dust
  sweep.addOutputAddress(fOnchain.address, BigInt(V) - fee, fOnchain.network)
  const signed = await F.identity.sign(sweep)
  signed.finalize()
  const beforeBal = await fOnchain.getBalance()
  let swept = false
  try {
    await esplora.broadcastTransaction(signed.hex)
    // mine + poll: esplora can lag a block behind the confirming mine
    for (let i = 0; i < 10 && !swept; i++) {
      regtest('mine', '1')
      await sleep(1200)
      const st = await esplora.getTxStatus(signed.id)
      swept = st.confirmed
    }
  } catch (e) {
    console.log(`  sweep broadcast error: ${e instanceof Error ? e.message : e}`)
  }
  check(swept, `uexit sweep confirmed onchain (txid ${signed.id.slice(0, 12)}…)`)
  const afterBal = await fOnchain.getBalance()
  check(afterBal > beforeBal, `F onchain balance grew by the swept V (Δ=${afterBal - beforeBal}, ~V−fee=${V - Number(fee)})`)

  // ---- claimer has no unilateral path (design note, not executable) ----
  // NOTE: VtxoScript.exitPaths() THROWS on our 4-leaf script (it tries to decode
  // the claim/refund leaves as CSV) — a #13 finding: the SDK's generic exit
  // resolver (prepareUnrollTransaction→availableExitPath→exitPaths) can't drive
  // our shared vtxo; vault/exit integration must resolve the uexit leaf directly
  // (as this spike's manual sweep does). So assert structurally, not via exitPaths.
  console.log('\nclaimer unilateral path check:')
  const uexitBytes = script.uexit()[1].subarray(0, script.uexit()[1].length - 1)
  const uexitHex = enc(uexitBytes)
  check(uexitHex.includes(enc(F.xonly)), 'the only CSV exit leaf (uexit) is F-only')
  check(!uexitHex.includes(enc(Cxonly)), 'C is NOT on any unilateral CSV path — claim/cancel need server co-sign; a would burn onchain (OP_RETURN)')

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(
    FAIL === 0
      ? `✅ F unilateral exit works — full V recovered via uexit leaf. §8: d=${d} ${dType} confirmed.`
      : '❌ FAILURES — see above',
  )
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
