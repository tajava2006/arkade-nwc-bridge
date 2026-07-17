// Validation for the 2026-07-17 mainnet false-funding: boltz's receive funding
// failed ("input amount is not equal to output amount") when its mini-wallet's
// only V-covering vtxo left SUB-DUST change. Root cause: the router passed
// `amount: V` to selectFunding (which expects `a`), inflating the regular-change
// threshold to 2·dust+a, so a vtxo in [V, V+dust) was skipped and the fallback
// returned one BELOW V → unbalanced tx.
//
// This drill reproduces the exact shape: drain boltz's mini-wallet, fund it with
// EXACTLY V + a-few (one vtxo that covers V=a+dust but leaves sub-dust change),
// then run an `a`-sat receive. With the fix (amount:a + tiered change + sub-dust
// OP_RETURN change) boltz must fund + the receiver must get `a`.
//
//   arkade-regtest up (seconds mode) with the REBUILT boltz-atomic:regtest
//   bun test/spike/atomic_subdust_change_funding.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { hex } from '@scure/base'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  DefaultVtxo,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
  type ArkInfo,
} from '@arkade-os/sdk'
import { SqliteAtomicSwapRepository } from '../../src/atomic'
import { issueAtomicReceive, driveAtomicReceive } from '../../src/atomic_receive'
import { openDatabase } from '../../src/db'

const ARKD_URL = 'http://localhost:7070'
const ESPLORA_URL = 'http://localhost:3000/api'
const BOLTZ_URL = 'http://localhost:9069'
const ARK_PW = 'secret'
const HRP = 'tark'
const BOLTZ_KEY = process.env.BOLTZ_KEY ?? '3820bf24c99fd1a1d20205e0237c73af9a0f998b6844aa1e87a09585354abe86'
const enc = (b: Uint8Array) => hex.encode(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))
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
  console.log('sub-dust-change funding — mini-wallet with only a V-covering, sub-dust-change vtxo\n')
  const scratch = mkdtempSync(join(tmpdir(), 'subdust-fund-'))
  const db = openDatabase(join(scratch, 'bridge.sqlite'))
  const repo = new SqliteAtomicSwapRepository(db)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  const tl = { type: d >= 512n ? ('seconds' as const) : ('blocks' as const), value: d }
  const a = 14
  const V = a + dust // 344
  // one vtxo that covers V but leaves sub-dust change (V < value < V + dust)
  const fundAmount = V + Math.floor(dust / 2) // e.g. 344 + 165 = 509 → change 165 (sub-dust)

  // ── constrain boltz's mini-wallet to exactly one such vtxo ──
  const boltzKey = SingleKey.fromPrivateKey(hex.decode(BOLTZ_KEY))
  const boltzXOnly = toXOnly(await boltzKey.xOnlyPublicKey())
  const boltzAddr = new DefaultVtxo.Script({ pubKey: boltzXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)
  const boltzWallet = await Wallet.create({
    identity: boltzKey,
    arkServerUrl: ARKD_URL,
    esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: { vtxoThreshold: 3600 },
  })
  const throwaway = await Wallet.create({
    identity: SingleKey.fromPrivateKey(randomBytes(32)),
    arkServerUrl: ARKD_URL, esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: { vtxoThreshold: 3600 },
  })
  // consolidate first — the mini-wallet accrues preconfirmed/near-expiry vtxos
  // across drills that getBalance counts but selectVirtualCoins can't fully
  // select; settling folds them into one clean spendable vtxo.
  try {
    await boltzWallet.settle()
    regtest('mine', '1')
    await sleep(1500)
  } catch (e) {
    console.log('  (settle skipped:', (e as Error).message.slice(0, 60), ')')
  }
  const avail = (await boltzWallet.getBalance()).available
  if (avail > 0) {
    await boltzWallet.sendBitcoin({ address: await throwaway.getAddress(), amount: avail })
    regtest('mine', '1')
    await sleep(1500)
  }
  check((await boltzWallet.getBalance()).available === 0, 'drained boltz mini-wallet to 0')

  regtest('ark', 'send', '--to', boltzAddr.encode(), '--amount', String(fundAmount), '--password', ARK_PW)
  regtest('mine', '1')
  for (let i = 0; i < 30 && (await boltzWallet.getBalance()).available < fundAmount; i++) await sleep(500)
  check(
    (await boltzWallet.getBalance()).available === fundAmount,
    `mini-wallet has exactly one ${fundAmount} vtxo (covers V=${V}, leaves sub-dust change ${fundAmount - V})`,
  )

  // ── receive: the funding step is what used to fail ──
  const bridge = SingleKey.fromPrivateKey(randomBytes(32))
  const bridgeXOnly = toXOnly(await bridge.xOnlyPublicKey())
  const bridgeAddr = new DefaultVtxo.Script({ pubKey: bridgeXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)
  const deps = { identity: bridge, arkServerUrl: ARKD_URL, db, boltzApiUrl: BOLTZ_URL }

  const issued = await issueAtomicReceive(deps, a)
  check(!!issued.swapId, `receive issued (a=${a}, swap ${issued.swapId.slice(0, 8)}…)`)
  execFileSync('docker', ['exec', '-d', 'lnd', 'lncli', '--network=regtest', 'payinvoice', '--force', issued.invoice], { encoding: 'utf8' })

  // the decisive step: boltz FUNDS the shared vtxo from the 509 (sub-dust change)
  let funded = false
  for (let i = 0; i < 45 && !funded; i++) {
    const res = await fetch(`${BOLTZ_URL}/v2/subdust/atomic/receive/status?swapId=${issued.swapId}`)
    if (res.ok) funded = ((await res.json()) as { state: string }).state === 'funded'
    if (!funded) await sleep(1000)
  }
  check(funded, 'boltz FUNDED the shared vtxo from the sub-dust-change vtxo (the mainnet failure point)')

  let settled = false
  for (let i = 0; i < 45 && !settled; i++) {
    settled = await driveAtomicReceive(deps, issued.swapId)
    if (!settled) await sleep(1000)
  }
  check(settled, 'driveAtomicReceive claimed + settled')

  let got = false
  for (let i = 0; i < 20 && !got; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [enc(bridgeAddr.pkScript)], recoverableOnly: true })
    got = vtxos.some((x) => x.value === a && !x.isSpent)
    if (!got) await sleep(500)
  }
  check(got, `receiver got the sub-dust a=${a}`)

  await boltzWallet.dispose?.()
  await throwaway.dispose?.()
  rmSync(scratch, { recursive: true, force: true })
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0
    ? '✅ SUB-DUST-CHANGE FUNDING WORKS — the mainnet false-funding is fixed'
    : '❌ see above')
  process.exit(FAIL === 0 ? 0 : 1)
}

void createHash
main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
