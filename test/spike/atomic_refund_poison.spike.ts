// Reproduction + FIX validation for the mainnet false-refund (2026-07-17).
//
// Root cause: the refund arkTx is DETERMINISTIC, and arkd keys its offchain
// event stream by arkTxid with full-stream replay on every projection. A
// submit that fails the CLTV check (FORFEIT_CLOSURE_LOCKED while blocktime <
// T) plants a Fail event; a later submit of the SAME txid then ACKs 200 but
// its Accepted-branch projection is tainted, so the vtxo is never marked spent
// — arkd returns success while the shared vtxo stays spendable. The bridge's
// old refund marked the swap "refunded" on the ACK → false refund.
//
// Fix under test: production refundAtomicSend (1) pre-gates on esplora MTP,
// (2) VERIFIES the funding outpoint actually left the spendable set before any
// bookkeeping, and (3) on a poisoned (ACKed-but-unregistered) txid re-mints a
// fresh txid by splitting V across a regular + sub-dust output to our own
// address. This drill poisons the clean txid, then asserts refundAtomicSend
// still recovers (via the split) and only then reports refunded.
//
//   arkade-regtest up (seconds mode)
//   bun test/spike/atomic_refund_poison.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
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
  refundSpend,
  serverUnrollScript,
  SqliteAtomicSwapRepository,
  SwapDirection,
  type AtomicOutput,
  type SharedVtxo,
} from '../../src/atomic'
import { refundAtomicSend } from '../../src/atomic_send'
import { openDatabase } from '../../src/db'

const ARKD_URL = 'http://localhost:7070'
const ESPLORA_URL = 'http://localhost:3000/api'
const ARK_PW = 'secret'
const HRP = 'tark'
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
  console.log('refund-poison: poison the clean txid, then verify the production fix recovers\n')
  const scratch = mkdtempSync(join(tmpdir(), 'refund-poison-'))
  const db = openDatabase(join(scratch, 'bridge.sqlite'))
  const repo = new SqliteAtomicSwapRepository(db)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnrollScript(info.checkpointTapscript)
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  const a = 30
  const V = a + dust

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
  for (let i = 0; i < 30 && (await wallet.getBalance()).available < 200000; i++) await sleep(500)
  const startBalance = (await wallet.getBalance()).available

  // T is just behind the wall clock but AHEAD of the chain's MTP once we stop
  // mining → the poison window.
  const H = randomBytes(32)
  const T = BigInt(Math.floor(Date.now() / 1000) - 30)
  const script = new AtomicVtxoScript({ funder: userXOnly, claimer: boltzXOnly, server: serverXOnly, paymentHash: H, refundLocktime: T, exitDelay: d })
  await wallet.sendBitcoin({ address: script.address(HRP, serverXOnly).encode(), amount: V })
  regtest('mine', '1')
  const sharedPk = enc(script.pkScript)
  let shared: SharedVtxo | undefined
  for (let i = 0; i < 20 && !shared; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === V)
    if (v) shared = { txid: v.txid, vout: v.vout, value: v.value, script }
    else await sleep(500)
  }
  if (!shared) throw new Error('shared vtxo never appeared')

  repo.create({
    id: 'poison-swap',
    direction: SwapDirection.Send,
    paymentHash: enc(H),
    state: 'init',
    amount: a,
    refundLocktime: Number(T),
    peerPubkey: enc(boltzXOnly),
    exitDelay: Number(d),
  })
  repo.setFundingOutpoint('poison-swap', `${shared.txid}:${shared.vout}`)
  repo.transition('poison-swap', 'funded')
  repo.transition('poison-swap', 'refund_wait')

  // ── POISON: submit the CLEAN single-output refund while blocktime < T ──
  const ourAddr = ArkAddress.decode(address)
  const cleanOutputs: AtomicOutput[] = [{ script: ourAddr.pkScript, amount: BigInt(V) }]
  let poisoned = false
  for (let i = 0; i < 3; i++) {
    try {
      await refundSpend(shared, cleanOutputs, unroll, identity, ark)
      break // MTP already past T; can't poison — rare, drill still meaningful below
    } catch (e) {
      if (/FORFEIT_CLOSURE_LOCKED/.test(e instanceof Error ? e.message : '')) poisoned = true
    }
    await sleep(800)
  }
  check(poisoned, 'clean refund txid POISONED (FORFEIT_CLOSURE_LOCKED planted a Fail event)')

  // advance the chain's MTP past T — now the clean txid would ACK-but-not-register
  regtest('mine', '12')
  await sleep(2000)

  // ── FIX: production refundAtomicSend must recover despite the poison ──
  console.log('\ncalling production refundAtomicSend (must detect the poison + re-mint)…')
  const res = await refundAtomicSend({ wallet, arkServerUrl: ARKD_URL, db, esploraUrl: ESPLORA_URL }, 'poison-swap')
  check(res.amount === V, `refundAtomicSend returned full V (${res.amount})`)
  check(repo.get('poison-swap')?.state === 'refunded', 'swap row = refunded')

  // the decisive check: the shared vtxo is ACTUALLY spent (not a false refund)
  await sleep(2000)
  const { vtxos: after } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
  const stillSpendable = after.some((x) => x.txid === shared!.txid && x.vout === shared!.vout)
  check(!stillSpendable, 'shared vtxo ACTUALLY spent (refund really landed — not a false refund)')

  // The poison-recovery path splits V into a regular + a k-sat sub-dust output,
  // so k sats land in `recoverable`, not `available` — the wallet is whole on
  // the TOTAL (available + recoverable), which is what matters.
  let total = 0
  for (let i = 0; i < 30; i++) {
    const b = await wallet.getBalance()
    total = b.available + (b.recoverable ?? 0)
    if (total >= startBalance) break
    await sleep(500)
  }
  check(total === startBalance, `wallet made whole on total (${total} == ${startBalance}; a few sats now sub-dust from the split)`)

  await wallet.dispose?.()
  rmSync(scratch, { recursive: true, force: true })
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0
    ? '✅ POISON RECOVERED — verify-before-bookkeep + fresh-txid split; no false refund'
    : '❌ see above')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
