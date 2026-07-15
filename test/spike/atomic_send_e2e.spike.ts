// #14 drill — the FIRST real end-to-end of the boltz atomic SEND path.
// bridge (this script, as funder F) ↔ our custom boltz (SubdustAtomicRouter) ↔
// regtest arkd + LN. Until now the boltz routers were typecheck-only; this is
// the runtime grade.
//
// Flow (send, ARK→LN): create a 21-sat invoice on the counterparty lnd →
// /send/init → fund the 4-leaf shared vtxo → presign → /send/fund → boltz pays
// the invoice via boltz-lnd and claims its `a` → assert claimed + preimage +
// the invoice settled.
//
//   arkade-regtest up with --profile boltz and BOLTZ_IMAGE=boltz-atomic:regtest
//   bun test/spike/atomic_send_e2e.spike.ts

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

// arkade-regtest lives under the operator workspace's ts-sdk clone.
const REGTEST_DIR =
  process.env.REGTEST_DIR ?? '/Users/zxcvjklkjasdflk/dev/ark/my-server/reference/ts-sdk/regtest'
const regtest = (...a: string[]) =>
  execFileSync('node', ['regtest.mjs', ...a], { cwd: REGTEST_DIR, encoding: 'utf8', maxBuffer: 1e7 })

// Create a sub-dust invoice on the counterparty lnd (boltz-lnd pays it).
function lndInvoice(amtSat: number): string {
  const out = execFileSync(
    'docker',
    ['exec', 'lnd', 'lncli', '--network=regtest', 'addinvoice', '--amt', String(amtSat)],
    { encoding: 'utf8' },
  )
  return JSON.parse(out).payment_request as string
}
function lndInvoiceSettled(paymentHashHex: string): boolean {
  const out = execFileSync(
    'docker',
    ['exec', 'lnd', 'lncli', '--network=regtest', 'lookupinvoice', paymentHashHex],
    { encoding: 'utf8' },
  )
  return JSON.parse(out).state === 'SETTLED'
}

let PASS = 0
let FAIL = 0
const check = (c: boolean, l: string) => {
  console.log(`  ${c ? '✅' : '❌'} ${l}`)
  c ? PASS++ : FAIL++
}

async function boltz<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BOLTZ_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text().catch(() => '')}`)
  return (await res.json()) as T
}

async function main(): Promise<void> {
  console.log(`atomic send e2e (#14) — boltz ${BOLTZ_URL}, arkd ${ARKD_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnrollScript(info.checkpointTapscript)
  const dust = Number(info.dust)
  const a = 21

  // Funder wallet (the bridge/user), funded from the regtest ark client.
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
  console.log('funding the funder wallet…')
  regtest('ark', 'send', '--to', address, '--amount', '200000', '--password', ARK_PW)
  regtest('mine', '1')
  for (let i = 0; i < 30 && (await wallet.getBalance()).available < 200000; i++) await sleep(500)
  check((await wallet.getBalance()).available >= 200000, `funder funded (${(await wallet.getBalance()).available})`)

  // 1. sub-dust invoice on lnd
  const invoice = lndInvoice(a)
  console.log(`\ncreated ${a}-sat invoice on lnd`)

  // 2. init with boltz
  const init = await boltz<{ swapId: string; boltzPubkey: string; refundLocktime: number; exitDelay: string }>(
    '/v2/subdust/atomic/send/init',
    { invoice, userPubkey: enc(userXOnly) },
  )
  check(!!init.swapId && !!init.boltzPubkey, `/send/init ok (swap ${init.swapId.slice(0, 8)}…, boltz ${init.boltzPubkey.slice(0, 12)}…)`)
  const boltzXOnly = toXOnly(hex.decode(init.boltzPubkey))
  const T = BigInt(init.refundLocktime)
  const d = BigInt(init.exitDelay)
  // H = sha256(preimage) — take it from the invoice via lncli decode.
  const decoded = JSON.parse(
    execFileSync('docker', ['exec', 'lnd', 'lncli', '--network=regtest', 'decodepayreq', invoice], { encoding: 'utf8' }),
  )
  const H = hex.decode(decoded.payment_hash as string)

  // 3. build the shared 4-leaf script + fund it (V = a + dust)
  const script = new AtomicVtxoScript({ funder: userXOnly, claimer: boltzXOnly, server: serverXOnly, paymentHash: H, refundLocktime: T, exitDelay: d })
  const V = a + dust
  const sharedAddr = script.address(HRP, serverXOnly).encode()
  await wallet.sendBitcoin({ address: sharedAddr, amount: V })
  regtest('mine', '1')
  const sharedPk = enc(script.pkScript)
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
  check(true, `funded shared vtxo ${shared.txid.slice(0, 12)}…:${shared.vout} (V=${V})`)

  // 4. presign the claim split
  const funderAddr = ArkAddress.decode(address)
  const timelockType = d >= 512n ? 'seconds' : 'blocks'
  const boltzAddr = new DefaultVtxo.Script({ pubKey: boltzXOnly, serverPubKey: serverXOnly, csvTimelock: { type: timelockType, value: d } }).address(HRP, serverXOnly)
  const split = computeClaimSplit({ funderAddress: funderAddr, claimerAddress: boltzAddr, fundingValue: V, amount: a, dust })
  const presig = await presignClaim({ ...shared, script }, split.outputs, unroll, identity)

  // 5. hand boltz the presigs → it pays + claims
  console.log('\nhanding boltz the presigs (/send/fund)…')
  const fund = await boltz<{ status: string; preimage?: string; claimTxid?: string; error?: string }>(
    '/v2/subdust/atomic/send/fund',
    { swapId: init.swapId, fundingOutpoint: `${shared.txid}:${shared.vout}`, presigs: presig },
  )
  check(fund.status === 'claimed', `boltz status = claimed (${fund.status}${fund.error ? ': ' + fund.error : ''})`)
  check(!!fund.preimage && enc(sha256(hex.decode(fund.preimage))) === enc(H), 'preimage matches the invoice payment hash')

  // 6. the LN invoice actually settled
  regtest('mine', '1')
  let settled = false
  for (let i = 0; i < 10 && !settled; i++) {
    settled = lndInvoiceSettled(decoded.payment_hash as string)
    if (!settled) await sleep(1000)
  }
  check(settled, 'lnd invoice settled (boltz-lnd paid it)')

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(
    FAIL === 0
      ? '✅ ATOMIC SEND WORKS END-TO-END — custom boltz paid a 21-sat invoice + claimed atomically'
      : '❌ FAILURES — see above',
  )
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
