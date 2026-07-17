// #14 drill — the #13 payoff: an in-flight send shared vtxo, once captured into
// the vault (source='atomic'), is a first-class citizen of the REAL exit engine.
// listVaultVtxos has no source filter, so the /exit tab + engine already
// enumerate it; this proves the engine's plan functions (estimateExit,
// buildExitStepper, availableExitPath) produce a valid uexit plan on a REAL
// captured atomic row — the on-chain unroll+sweep EXECUTION is #02-proven
// (identical code for any vtxo), so this covers the integration surface without
// an 8-minute on-chain CSV wait.
//
//   arkade-regtest up (seconds mode)
//   bun test/spike/atomic_exit_plan.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
  type ArkInfo,
} from '@arkade-os/sdk'
import { AtomicVtxoScript } from '../../src/atomic'
import { captureVtxo, expirySec } from '../../src/exit/proof_sync'
import { getVaultVtxo, listVaultVtxos } from '../../src/exit/vault'
import { estimateExit } from '../../src/exit/estimate'
import { buildExitStepper } from '../../src/exit/stepper'
import { availableExitPath } from '../../src/exit/csv'
import { createOrRestartExitOp, setExitOpState } from '../../src/exit/ops'
import { openDatabase } from '../../src/db'

const ARKD_URL = 'http://localhost:7070'
const ESPLORA_URL = 'http://localhost:3000/api'
const ARK_PW = 'secret'
const HRP = 'tark'
const enc = (b: Uint8Array) => hex.encode(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))
// The exact uexit leaf bytes arkd accepted in #02 (see atomic_script.test.ts).
const REGTEST_DIR = '/Users/zxcvjklkjasdflk/dev/ark/my-server/reference/ts-sdk/regtest'
const regtest = (...a: string[]) =>
  execFileSync('node', ['regtest.mjs', ...a], { cwd: REGTEST_DIR, encoding: 'utf8', maxBuffer: 1e7 })

let PASS = 0
let FAIL = 0
const check = (c: boolean, l: string) => {
  console.log(`  ${c ? '✅' : '❌'} ${l}`)
  c ? PASS++ : FAIL++
}

async function main(): Promise<void> {
  console.log(`atomic EXIT-PLAN e2e (#14) — real exit engine over a captured atomic row\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'atomic-exitplan-'))
  const db = openDatabase(join(scratch, 'bridge.sqlite'))
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  const a = 21
  const V = a + dust

  // fund a real shared vtxo (funder=us, claimer=throwaway boltz key)
  const identity = SingleKey.fromPrivateKey(randomBytes(32))
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARKD_URL,
    esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: { vtxoThreshold: 3600 },
  })
  const userXOnly = toXOnly(await identity.xOnlyPublicKey())
  const boltzXOnly = toXOnly(await SingleKey.fromPrivateKey(randomBytes(32)).xOnlyPublicKey())
  const address = await wallet.getAddress()
  regtest('ark', 'send', '--to', address, '--amount', '200000', '--password', ARK_PW)
  regtest('mine', '1')
  for (let i = 0; i < 30 && (await wallet.getBalance()).available < V; i++) await sleep(500)

  const script = new AtomicVtxoScript({
    funder: userXOnly,
    claimer: boltzXOnly,
    server: serverXOnly,
    paymentHash: randomBytes(32),
    refundLocktime: BigInt(Math.floor(Date.now() / 1000) + 3600),
    exitDelay: d,
  })
  await wallet.sendBitcoin({ address: script.address(HRP, serverXOnly).encode(), amount: V })
  regtest('mine', '1')
  const sharedPk = enc(script.pkScript)
  let shared: { txid: string; vout: number; value: number; coin: { virtualStatus?: unknown } } | undefined
  for (let i = 0; i < 20 && !shared; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === V)
    if (v) shared = { txid: v.txid, vout: v.vout, value: v.value, coin: v }
    else await sleep(500)
  }
  if (!shared) throw new Error('shared vtxo never appeared')

  // #13 capture — the exact production call atomic_send makes at funding
  await captureVtxo(db, indexer, {
    txid: shared.txid, vout: shared.vout, valueSat: shared.value,
    source: 'atomic', script: sharedPk, tapTree: enc(script.encode()),
    status: 'preconfirmed', expiresAt: expirySec(shared.coin),
  })
  const row = getVaultVtxo(db, shared.txid, shared.vout)
  check(row?.source === 'atomic', `captured atomic row (source=${row?.source}, V=${row?.valueSat})`)

  // 1. the engine ENUMERATES it (listVaultVtxos — the /exit tab + engine feed).
  const enumerated = listVaultVtxos(db).some((v) => v.txid === shared!.txid && v.source === 'atomic')
  check(enumerated, 'exit engine enumerates the atomic row (no source filter — /exit tab shows it)')

  // 2. estimateExit produces a real plan AND flags it uneconomical (the whole
  //    economics point: V=351 can't clear the unroll+sweep fees).
  const est = estimateExit(db, shared.txid, shared.vout, 2)
  check(est !== null && est.proofComplete, `estimateExit: full plan, proofs complete (${est?.packages} packages)`)
  check(!!est && est.unrollVb > 0 && est.sweepVb > 0, `estimateExit: unroll ${est?.unrollVb}vB + sweep ${est?.sweepVb}vB priced`)
  check(!!est && est.uneconomical, `estimateExit: flagged UNECONOMICAL (fee ${est?.totalFeeSat} > V ${V} — solo exit burns more than it recovers)`)

  // 3. buildExitStepper builds the unroll DAG from the REAL chain. With an
  //    active exit op parked at 'waiting', the wait step reads the uexit CSV
  //    (512s seconds-mode) straight off the atomic tapTree.
  const stepper = buildExitStepper({ db }, shared.txid, shared.vout, 2)
  check(stepper !== null && stepper.levels.length > 0, `buildExitStepper: DAG built (${stepper?.levels.length} levels, ${stepper?.probe.length} probe txs)`)
  createOrRestartExitOp(db, shared.txid, shared.vout)
  setExitOpState(db, shared.txid, shared.vout, 'waiting')
  const waitingStepper = buildExitStepper({ db }, shared.txid, shared.vout, 2)
  check(
    !!waitingStepper && waitingStepper.wait.unit === 'seconds' && waitingStepper.wait.need === Number(d),
    `stepper (waiting op) reads the uexit CSV off the tapTree (${waitingStepper?.wait.need}s)`,
  )

  // 4. availableExitPath targets the uexit leaf once the CSV has elapsed.
  const nowT = Math.floor(Date.now() / 1000)
  const confirmedAt = { height: 100, time: nowT - Number(d) - 100 } // CSV elapsed
  const tip = { height: 200, time: nowT }
  const path = availableExitPath(enc(script.encode()), confirmedAt, tip)
  check(!!path && hex.encode(path.script) === script.uexitLeafHex, 'availableExitPath resolves to the uexit leaf (CSV elapsed)')
  const notYet = availableExitPath(enc(script.encode()), { height: 100, time: nowT - 10 }, tip)
  check(notYet === undefined, 'availableExitPath returns nothing before the CSV elapses (no premature exit)')

  await wallet.dispose?.()
  rmSync(scratch, { recursive: true, force: true })
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0 ? '✅ EXIT ENGINE OWNS THE ATOMIC ROW — enumerated, priced (uneconomical), unroll DAG + uexit CSV planned' : '❌ FAILURES')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
