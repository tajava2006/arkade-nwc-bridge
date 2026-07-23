// #14 drill — the WIRED bridge, first runtime. Prior drills exercised the
// atomic CORE (computeClaimSplit/presignClaim/finishClaim) directly; this one
// runs the PRODUCTION bridge wrappers — atomicSubdustSend (send) and
// issueAtomicReceive + driveAtomicReceive (receive) — with real Wallet/db/boltz.
// Those wrappers add the vault capture, the atomic_swaps lifecycle, and the
// row-release bookkeeping that #12/#13 wired but nothing had run live.
//
// It stands in for the operator's "two bridges" idea: bridge B receives, bridge
// A sends, each through its own db + wallet. NOTE it is deliberately NOT a
// closed A→B loop — both bridges share one boltz (= one LN node, boltz-lnd), so
// A paying B's invoice would be boltz-lnd paying itself (LND rejects self-pay).
// A sends to the external `lnd`, B receives from the external `lnd`; the direct
// two-bridge loop is impossible with a single boltz (matters for the mainnet
// test design too — each side must face EXTERNAL LN).
//
//   arkade-regtest up (seconds mode) with BOLTZ_IMAGE=boltz-atomic:regtest
//   bun test/spike/atomic_wired_e2e.spike.ts

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
import { atomicSubdustSend } from '../../src/atomic/send'
import { issueAtomicReceive, driveAtomicReceive } from '../../src/atomic/receive'
import { getVaultVtxo } from '../../src/exit/vault'
import { openDatabase } from '../../src/db'

const ARKD_URL = 'http://localhost:7070'
const ESPLORA_URL = 'http://localhost:3000/api'
const BOLTZ_URL = 'http://localhost:9069'
const ARK_PW = 'secret'
const HRP = 'tark'
// Matches compose.ark.yml subdustSignerKey — boltz funds the receive shared
// vtxo from this key's mini-wallet, so the drill tops it up (a setup step).
const BOLTZ_KEY = '3820bf24c99fd1a1d20205e0237c73af9a0f998b6844aa1e87a09585354abe86'
const enc = (b: Uint8Array) => hex.encode(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))
const REGTEST_DIR = '/Users/zxcvjklkjasdflk/dev/ark/my-server/reference/ts-sdk/regtest'
const regtest = (...a: string[]) =>
  execFileSync('node', ['regtest.mjs', ...a], { cwd: REGTEST_DIR, encoding: 'utf8', maxBuffer: 1e7 })
const lnd = (...a: string[]) =>
  execFileSync('docker', ['exec', 'lnd', 'lncli', '--network=regtest', ...a], { encoding: 'utf8' })

let PASS = 0
let FAIL = 0
const check = (c: boolean, l: string) => {
  console.log(`  ${c ? '✅' : '❌'} ${l}`)
  c ? PASS++ : FAIL++
}

async function makeWallet(): Promise<Wallet> {
  return Wallet.create({
    identity: SingleKey.fromPrivateKey(randomBytes(32)),
    arkServerUrl: ARKD_URL,
    esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: { vtxoThreshold: 3600 },
  })
}

async function main(): Promise<void> {
  console.log(`atomic WIRED e2e (#14) — production bridge wrappers, boltz ${BOLTZ_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  const tl = { type: d >= 512n ? ('seconds' as const) : ('blocks' as const), value: d }
  const a = 21
  const scratch = mkdtempSync(join(tmpdir(), 'atomic-wired-'))

  // ── Bridge B: RECEIVE via the production wrappers ─────────────────────────
  console.log('── bridge B: receive (issueAtomicReceive + driveAtomicReceive) ──')
  const dbB = openDatabase(join(scratch, 'bridgeB.sqlite'))
  const repoB = new SqliteAtomicSwapRepository(dbB)
  const idB = SingleKey.fromPrivateKey(randomBytes(32))
  const bridgeBXOnly = toXOnly(await idB.xOnlyPublicKey())
  const bridgeBAddr = new DefaultVtxo.Script({ pubKey: bridgeBXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)
  const depsB = { identity: idB, arkServerUrl: ARKD_URL, db: dbB, boltzApiUrl: BOLTZ_URL }

  // fund boltz's mini-wallet (boltz = funder on receive)
  const boltzKey = SingleKey.fromPrivateKey(hex.decode(BOLTZ_KEY))
  const boltzAddr = new DefaultVtxo.Script({ pubKey: toXOnly(await boltzKey.xOnlyPublicKey()), serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)
  regtest('ark', 'send', '--to', boltzAddr.encode(), '--amount', '100000', '--password', ARK_PW)
  regtest('mine', '1')
  await sleep(1500)

  const issued = await issueAtomicReceive(depsB, a)
  check(!!issued.swapId && issued.invoice.startsWith('ln'), `issueAtomicReceive minted a hold invoice (swap ${issued.swapId.slice(0, 8)}…)`)
  check(repoB.get(issued.swapId)?.state === 'invoice_issued', 'swap row persisted (invoice_issued, preimage stored)')

  // external payer pays the hold invoice — stays in-flight until we claim
  execFileSync('docker', ['exec', '-d', 'lnd', 'lncli', '--network=regtest', 'payinvoice', '--force', issued.invoice], { encoding: 'utf8' })
  console.log('  external payer (lnd) paying the hold invoice…')

  // drive to settlement (production driveAtomicReceive: verify→claim→settle)
  let settled = false
  for (let i = 0; i < 45 && !settled; i++) {
    settled = await driveAtomicReceive(depsB, issued.swapId)
    if (!settled) await sleep(1000)
  }
  check(settled, 'driveAtomicReceive settled the swap')
  check(repoB.get(issued.swapId)?.state === 'settled', 'swap row = settled')

  const bridgeBPk = enc(bridgeBAddr.pkScript)
  let received = false
  for (let i = 0; i < 20 && !received; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [bridgeBPk], recoverableOnly: true })
    received = vtxos.some((x) => x.value === a && !x.isSpent)
    if (!received) await sleep(500)
  }
  check(received, `bridge B holds the sub-dust a=${a} (recoverable vtxo)`)

  // ── Bridge A: SEND via the production wrapper ─────────────────────────────
  console.log('\n── bridge A: send (atomicSubdustSend) ──')
  const dbA = openDatabase(join(scratch, 'bridgeA.sqlite'))
  const repoA = new SqliteAtomicSwapRepository(dbA)
  const walletA = await makeWallet()
  const addrA = await walletA.getAddress()
  regtest('ark', 'send', '--to', addrA, '--amount', '200000', '--password', ARK_PW)
  regtest('mine', '1')
  for (let i = 0; i < 30 && (await walletA.getBalance()).available < 200000; i++) await sleep(500)
  const startA = (await walletA.getBalance()).available
  check(startA >= 200000, `bridge A funded (${startA})`)

  // A sends to an EXTERNAL lnd invoice (not B — that would be boltz-lnd self-pay)
  const invoice = JSON.parse(lnd('addinvoice', '--amt', String(a))).payment_request as string
  const sendRes = await atomicSubdustSend({ wallet: walletA, arkServerUrl: ARKD_URL, db: dbA, boltzApiUrl: BOLTZ_URL }, invoice, a)
  check(sendRes.amount === a && !!sendRes.preimage, `atomicSubdustSend claimed (a=${sendRes.amount}, preimage revealed)`)

  const sentRow = repoA.list().find((s) => s.direction === 'send')
  check(sentRow?.state === 'claimed', `send swap row = claimed`)
  // vault row captured at funding must be released on the claim
  const [ftxid, fvout] = (sentRow?.fundingOutpoint ?? ':').split(':')
  check(!!ftxid && getVaultVtxo(dbA, ftxid, Number(fvout)) === null, 'vault row released on claim (lifecycle GC)')

  // net wallet cost = a (V=a+dust funded, dust change returns)
  let endA = 0
  for (let i = 0; i < 30; i++) {
    endA = (await walletA.getBalance()).available
    if (startA - endA === a) break
    await sleep(500)
  }
  check(startA - endA === a, `bridge A net cost = a (${startA} → ${endA}, spent ${startA - endA})`)

  await walletA.dispose?.()
  rmSync(scratch, { recursive: true, force: true })
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0 ? '✅ WIRED BRIDGE WORKS — production send + receive wrappers, both directions live' : '❌ FAILURES')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
