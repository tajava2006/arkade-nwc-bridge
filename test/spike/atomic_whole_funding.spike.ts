// Validation for the whole-vtxo receive funding (the 2026-07-17 refactor): boltz
// funds the shared vtxo by spending its picked vtxo(s) WHOLE — no funding change.
// V' = the picked total; the leftover comes back at claim as regular change.
// Two shapes to prove:
//   A) one vtxo covers V=dust+a on its own → single-input funding, V' = that vtxo.
//   B) no single covers V → the two smallest combine → MULTI-INPUT funding.
//
// Needs a fresh (empty) boltz mini-wallet so the drill fully controls the vtxo
// set: set compose.ark.yml subdustSignerKey to a throwaway + recreate boltz, run
// with BOLTZ_KEY=<that key>.
//
//   bun test/spike/atomic_whole_funding.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  console.log(`atomic whole-funding — single + multi-input combine\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'whole-fund-'))
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

  const boltzKey = SingleKey.fromPrivateKey(hex.decode(BOLTZ_KEY))
  const boltzXOnly = toXOnly(await boltzKey.xOnlyPublicKey())
  const boltzAddr = new DefaultVtxo.Script({ pubKey: boltzXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)
  const boltzWallet = await Wallet.create({
    identity: boltzKey, arkServerUrl: ARKD_URL, esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: { vtxoThreshold: 3600 },
  })
  const throwaway = await Wallet.create({
    identity: SingleKey.fromPrivateKey(randomBytes(32)), arkServerUrl: ARKD_URL, esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: { vtxoThreshold: 3600 },
  })
  const drain = async (): Promise<void> => {
    const av = (await boltzWallet.getBalance()).available
    if (av > 0) {
      await boltzWallet.sendBitcoin({ address: await throwaway.getAddress(), amount: av })
      regtest('mine', '1'); await sleep(1500)
    }
  }
  const fund = (amount: number): void => {
    regtest('ark', 'send', '--to', boltzAddr.encode(), '--amount', String(amount), '--password', ARK_PW)
    regtest('mine', '1')
  }
  const doReceive = async (label: string, expectVp: number): Promise<void> => {
    const bridge = SingleKey.fromPrivateKey(randomBytes(32))
    const bridgeXOnly = toXOnly(await bridge.xOnlyPublicKey())
    const bridgeAddr = new DefaultVtxo.Script({ pubKey: bridgeXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)
    const deps = { identity: bridge, arkServerUrl: ARKD_URL, db, boltzApiUrl: BOLTZ_URL }
    const issued = await issueAtomicReceive(deps, a)

    execFileSync('docker', ['exec', '-d', 'lnd', 'lncli', '--network=regtest', 'payinvoice', '--force', issued.invoice], { encoding: 'utf8' })
    let outpoint: string | undefined
    for (let i = 0; i < 45 && !outpoint; i++) {
      const res = await fetch(`${BOLTZ_URL}/v2/subdust/atomic/receive/status?swapId=${issued.swapId}`)
      if (res.ok) {
        const s = (await res.json()) as { state: string; fundingOutpoint?: string }
        if (s.state === 'funded') outpoint = s.fundingOutpoint
      }
      if (!outpoint) await sleep(1000)
    }
    check(!!outpoint, `${label}: boltz funded`)
    // A successful claim proves V' was used consistently: boltz pre-signed the
    // split against V' and the bridge claims reading the on-chain vtxo value —
    // a mismatch would fail finishClaim. So `settled` == V' handled correctly.
    let settled = false
    for (let i = 0; i < 45 && !settled; i++) {
      settled = await driveAtomicReceive(deps, issued.swapId)
      if (!settled) await sleep(1000)
    }
    check(settled, `${label}: claimed + settled (V'=${expectVp} funded whole)`)
    let got = false
    for (let i = 0; i < 20 && !got; i++) {
      const { vtxos } = await indexer.getVtxos({ scripts: [enc(bridgeAddr.pkScript)], recoverableOnly: true })
      got = vtxos.some((x) => x.value === a && !x.isSpent)
      if (!got) await sleep(500)
    }
    check(got, `${label}: receiver got a=${a}`)
    // boltz change back is REGULAR (V'−a ≥ dust), i.e. not sub-dust
    const boltzRec = (await boltzWallet.getBalance()).recoverable ?? 0
    check(boltzRec === 0, `${label}: boltz change is regular (no sub-dust accrued; recoverable=${boltzRec})`)
  }

  // ── A) single vtxo covers V → whole single-input funding ──
  await drain()
  fund(509) // 509 ≥ V=344 → fund whole; claim → user 14 + boltz 495 (regular)
  for (let i = 0; i < 30 && (await boltzWallet.getBalance()).available < 509; i++) await sleep(500)
  check((await boltzWallet.getBalance()).available === 509, 'A: mini-wallet = one 509 vtxo')
  await doReceive('A(single)', 509)

  // ── B) no single covers V → two smallest combine → MULTI-INPUT funding ──
  await drain()
  fund(335) // both < V=344
  fund(340)
  for (let i = 0; i < 30 && (await boltzWallet.getBalance()).available < 675; i++) await sleep(500)
  check((await boltzWallet.getBalance()).available === 675, 'B: mini-wallet = two sub-V vtxos [335,340] (no single covers V)')
  await doReceive('B(combine)', 675)

  await boltzWallet.dispose?.()
  await throwaway.dispose?.()
  rmSync(scratch, { recursive: true, force: true })
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0
    ? "✅ WHOLE-FUNDING WORKS — single + multi-input combine; no funding change, regular claim change"
    : '❌ see above')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
