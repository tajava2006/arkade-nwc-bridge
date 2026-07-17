// #14 drill — the SEND failure path (the trustlessness guarantee): when boltz's
// LN payment fails, boltz must NOT claim the user's funding, so the user can
// reclaim the full V after T. We force a terminal LN failure with a CANCELED
// hold invoice on lnd (non-disruptive — no stopping containers).
//
//   bun test/spike/atomic_send_fail_e2e.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { hex } from '@scure/base'
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

const ARKD_URL = 'http://localhost:7070'
const ESPLORA_URL = 'http://localhost:3000/api'
const BOLTZ_URL = 'http://localhost:9069'
const ARK_PW = 'secret'
const HRP = 'tark'
const enc = (b: Uint8Array) => hex.encode(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))
const sha256 = (b: Uint8Array) => Uint8Array.from(createHash('sha256').update(b).digest())
const REGTEST_DIR = '/Users/zxcvjklkjasdflk/dev/ark/my-server/reference/ts-sdk/regtest'
const regtest = (...a: string[]) => execFileSync('node', ['regtest.mjs', ...a], { cwd: REGTEST_DIR, encoding: 'utf8', maxBuffer: 1e7 })
const lnd = (...a: string[]) => execFileSync('docker', ['exec', 'lnd', 'lncli', '--network=regtest', ...a], { encoding: 'utf8' })

let PASS = 0
let FAIL = 0
const check = (c: boolean, l: string) => {
  console.log(`  ${c ? '✅' : '❌'} ${l}`)
  c ? PASS++ : FAIL++
}
async function boltz<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BOLTZ_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()) as T
}

async function main(): Promise<void> {
  console.log(`atomic send FAIL e2e (#14) — boltz ${BOLTZ_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnrollScript(info.checkpointTapscript)
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  const a = 21

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
  check((await wallet.getBalance()).available >= 200000, 'funder funded')

  // A hold invoice on lnd that we immediately CANCEL → any payment to it fails.
  const preimage = randomBytes(32)
  const H = sha256(preimage)
  const invoice = JSON.parse(lnd('addholdinvoice', enc(H), '--amt', String(a))).payment_request as string
  lnd('cancelinvoice', enc(H))
  console.log('created + canceled a hold invoice (boltz can never pay it)')

  const init = await boltz<{ swapId: string; boltzPubkey: string; refundLocktime: number; exitDelay: string }>(
    '/v2/subdust/atomic/send/init',
    { invoice, userPubkey: enc(userXOnly) },
  )
  const boltzXOnly = toXOnly(hex.decode(init.boltzPubkey))
  const T = BigInt(init.refundLocktime)
  const script = new AtomicVtxoScript({ funder: userXOnly, claimer: boltzXOnly, server: serverXOnly, paymentHash: H, refundLocktime: T, exitDelay: d })
  const V = a + dust
  await wallet.sendBitcoin({ address: script.address(HRP, serverXOnly).encode(), amount: V })
  regtest('mine', '1')
  const sharedPk = enc(script.pkScript)
  let shared: { txid: string; vout: number } | undefined
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === V)
    if (v) {
      shared = { txid: v.txid, vout: v.vout }
      break
    }
    await sleep(500)
  }
  if (!shared) throw new Error('shared vtxo never appeared')
  check(true, `funded shared vtxo ${shared.txid.slice(0, 12)}…`)

  const funderAddr = ArkAddress.decode(address)
  const boltzAddr = new DefaultVtxo.Script({ pubKey: boltzXOnly, serverPubKey: serverXOnly, csvTimelock: { type: d >= 512n ? 'seconds' : 'blocks', value: d } }).address(HRP, serverXOnly)
  const split = computeClaimSplit({ funderAddress: funderAddr, claimerAddress: boltzAddr, fundingValue: V, amount: a, dust })
  const presig = await presignClaim({ ...shared, value: V, script }, split.outputs, unroll, identity)

  // boltz verifies, tries to pay the (canceled) invoice → terminal failure.
  console.log('\nhanding boltz the presigs — its LN pay must fail…')
  const fund = await boltz<{ status: string; error?: string }>('/v2/subdust/atomic/send/fund', {
    swapId: init.swapId,
    fundingOutpoint: `${shared.txid}:${shared.vout}`,
    presigs: presig,
  })
  check(fund.status === 'failed', `boltz status = failed (${fund.status})`)

  // The trustlessness guarantee: boltz did NOT claim — the shared vtxo is still
  // unspent, so the user can reclaim the full V after T.
  regtest('mine', '1')
  await sleep(1000)
  const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
  // The shared vtxo being unspent IS the proof boltz claimed nothing — with the
  // claim leaf unspent, no `a` could have moved to boltz. (Checking boltz's
  // address for a 21-sat vtxo would false-positive on prior successful sends,
  // since boltz reuses one signer key across the whole drill.)
  const stillThere = vtxos.some((x) => x.txid === shared!.txid && x.vout === shared!.vout && !x.isSpent)
  check(stillThere, 'shared vtxo UNSPENT — boltz did not claim; user can refund after T (funds safe)')

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0 ? '✅ SEND FAILURE SAFE — LN fail → boltz claims nothing → user funds refundable' : '❌ FAILURES')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
