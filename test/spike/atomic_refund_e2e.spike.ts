// #14 drill — the T-REFUND path, exercising the PRODUCTION refund code
// (refundAtomicSend + captureVtxo + the v3 vault lifecycle) against real arkd.
//
// boltz is deliberately absent: refund IS the boltz-is-gone path. The swap row
// is planted the way a failed atomicSubdustSend leaves it (refund_wait, with
// peer_pubkey/exit_delay persisted), with T already in the past so the drill
// doesn't wait out MTP — CLTV enforcement both ways was #01's business; this
// drill proves the row-only script rebuild + spend + bookkeeping.
//
//   arkade-regtest up (seconds mode)
//   bun test/spike/atomic_refund_e2e.spike.ts

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
import { AtomicVtxoScript, SqliteAtomicSwapRepository, SwapDirection } from '../../src/atomic'
import { atomicSubdustSend, refundAtomicSend } from '../../src/atomic_send'
import { captureVtxo, expirySec } from '../../src/exit/proof_sync'
import { getVaultVtxo, isVtxoExitReady } from '../../src/exit/vault'
import { openDatabase } from '../../src/db'

void atomicSubdustSend // (the flow this drill's row-planting mirrors)

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
  console.log(`atomic T-refund e2e (#14) — arkd ${ARKD_URL}, production refundAtomicSend\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'atomic-refund-drill-'))
  const db = openDatabase(join(scratch, 'bridge.sqlite'))
  const repo = new SqliteAtomicSwapRepository(db)

  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  const a = 21
  const V = a + dust

  // funder wallet (bridge)
  const identity = SingleKey.fromPrivateKey(randomBytes(32))
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARKD_URL,
    esploraUrl: ESPLORA_URL,
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: { vtxoThreshold: 3600 },
  })
  const userXOnly = toXOnly(await identity.xOnlyPublicKey())
  const address = await wallet.getAddress()
  regtest('ark', 'send', '--to', address, '--amount', '200000', '--password', ARK_PW)
  regtest('mine', '1')
  for (let i = 0; i < 30 && (await wallet.getBalance()).available < 200000; i++) await sleep(500)
  const startBalance = (await wallet.getBalance()).available
  check(startBalance >= 200000, `funder funded (${startBalance})`)

  // Plant the swap the way a failed atomicSubdustSend leaves it: boltz's key is
  // a throwaway (boltz is gone — that's the scenario), T already elapsed.
  const boltzKey = SingleKey.fromPrivateKey(randomBytes(32))
  const boltzXOnly = toXOnly(await boltzKey.xOnlyPublicKey())
  const H = randomBytes(32)
  // arkd enforces the CLTV against BLOCKTIME (MTP-ish), which lags wall clock —
  // ~35 min here after an idle night, ~1h on mainnet. First run with T=now−300
  // bounced with FORFEIT_CLOSURE_LOCKED. So: T well past, and mine 11 blocks
  // after funding to drag the median up to now.
  const T = BigInt(Math.floor(Date.now() / 1000) - 7200)
  const script = new AtomicVtxoScript({
    funder: userXOnly,
    claimer: boltzXOnly,
    server: serverXOnly,
    paymentHash: H,
    refundLocktime: T,
    exitDelay: d,
  })
  repo.create({
    id: 'refund-drill',
    direction: SwapDirection.Send,
    paymentHash: enc(H),
    state: 'init',
    amount: a,
    refundLocktime: Number(T),
    peerPubkey: enc(boltzXOnly),
    exitDelay: Number(d),
  })

  // fund the shared vtxo exactly like production does
  await wallet.sendBitcoin({ address: script.address(HRP, serverXOnly).encode(), amount: V })
  regtest('mine', '11') // fresh timestamps → MTP catches up past T
  const sharedPk = enc(script.pkScript)
  let shared: { txid: string; vout: number; value: number; coin: { virtualStatus?: unknown } } | undefined
  for (let i = 0; i < 20 && !shared; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === V)
    if (v) shared = { txid: v.txid, vout: v.vout, value: v.value, coin: v }
    else await sleep(500)
  }
  if (!shared) throw new Error('shared vtxo never appeared')
  check(true, `funded shared vtxo ${shared.txid.slice(0, 12)}… (V=${V})`)
  repo.setFundingOutpoint('refund-drill', `${shared.txid}:${shared.vout}`)
  repo.transition('refund-drill', 'funded')
  repo.transition('refund-drill', 'refund_wait') // where a failed LN pay lands it

  // #13 capture against the REAL indexer (production args)
  await captureVtxo(db, indexer, {
    txid: shared.txid,
    vout: shared.vout,
    valueSat: shared.value,
    source: 'atomic',
    script: sharedPk,
    tapTree: enc(script.encode()),
    status: 'preconfirmed',
    expiresAt: expirySec(shared.coin),
  })
  const vaultRow = getVaultVtxo(db, shared.txid, shared.vout)
  check(vaultRow?.source === 'atomic', `vault captured the shared vtxo (source=${vaultRow?.source})`)
  check(isVtxoExitReady(db, shared.txid, shared.vout), 'vault row is exit-ready (all proofs fetched from real indexer)')

  // guard: a swap whose T is in the future must refuse locally (pre-network)
  repo.create({
    id: 'refund-early',
    direction: SwapDirection.Send,
    paymentHash: 'ee'.repeat(32),
    state: 'init',
    amount: a,
    refundLocktime: Math.floor(Date.now() / 1000) + 3600,
    peerPubkey: enc(boltzXOnly),
    exitDelay: Number(d),
  })
  repo.setFundingOutpoint('refund-early', 'de'.repeat(32) + ':0')
  repo.transition('refund-early', 'funded')
  let earlyRefused = false
  try {
    await refundAtomicSend({ wallet, arkServerUrl: ARKD_URL, db }, 'refund-early')
  } catch (e) {
    earlyRefused = /until T/.test((e as Error).message)
  }
  check(earlyRefused, 'pre-T refund refused locally (CLTV would reject anyway)')

  // the real thing: full V back through the refund leaf, boltz nowhere in sight
  console.log('\nexecuting refundAtomicSend (production code)…')
  const refund = await refundAtomicSend({ wallet, arkServerUrl: ARKD_URL, db }, 'refund-drill')
  check(refund.amount === V, `refund returned the full V (${refund.amount})`)
  check(!!refund.txid, `refund arkTx ${refund.txid.slice(0, 12)}…`)
  check(repo.get('refund-drill')?.state === 'refunded', 'swap state = refunded')
  check(getVaultVtxo(db, shared.txid, shared.vout) === null, 'vault row released (lifecycle GC)')

  // balance reconciliation: refund is value-preserving — net cost 0
  let finalBalance = 0
  for (let i = 0; i < 30; i++) {
    finalBalance = (await wallet.getBalance()).available
    if (finalBalance >= startBalance) break
    await sleep(500)
  }
  check(finalBalance === startBalance, `wallet made whole (${finalBalance} == ${startBalance}) — net cost 0`)

  await wallet.dispose?.()
  rmSync(scratch, { recursive: true, force: true })
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0 ? '✅ T-REFUND WORKS — row-only rebuild, full V back, vault released' : '❌ FAILURES')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
