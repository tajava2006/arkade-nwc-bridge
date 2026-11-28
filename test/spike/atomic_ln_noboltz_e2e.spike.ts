// Feasibility: atomic SUB-DUST Lightning swaps, both directions, with NO Boltz and NO fulmine —
// the server role is an SDK 0.5 wallet + its own LND (`lnd`), the outside world is `lnd-peer`.
// Real LN payments over the regtest channel; arkd = our fork v0.9.26.
//
//   1. receive OK   : hold invoice -> payer HTLC held -> S funds shared + presigns -> U claims
//                     with P -> S harvests P from the claim -> settles -> payer SUCCEEDED
//   2. send OK      : U funds shared + presigns -> S pays the payee's sub-dust invoice -> claims
//   3. send FAIL    : payee cancels -> S's payment FAILED -> presigned cancel returns all to U
//   4. receive FAIL : U never claims -> after T, S refunds + cancels the hold -> payer FAILED
//
// REGTEST_DIR=…/regtest bun test/spike/atomic_ln_noboltz_e2e.spike.ts

import '../../src/polyfills'
import { execFileSync, spawn } from 'node:child_process'
import { hex, base64 } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  ArkAddress,
  ConditionWitness,
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Transaction,
  Wallet,
  getArkPsbtFields,
} from '@arkade-os/sdk'
import {
  AtomicVtxoScript,
  computeClaimSplit,
  finishCancel,
  finishClaim,
  presignCancel,
  presignClaim,
  refundSpend,
  serverUnrollScript,
  type AtomicOutput,
  type SharedVtxo,
} from '../../src/atomic'

const ARKD_URL = 'http://localhost:7070'
const ESPLORA_URL = 'http://localhost:3000/api'
const HRP = 'tark'
const REGTEST_DIR = process.env.REGTEST_DIR!
const enc = (b: Uint8Array) => hex.encode(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const toXOnly = (k: Uint8Array) => (k.length === 32 ? k : k.subarray(1))
const nowSecs = () => BigInt(Math.floor(Date.now() / 1000))

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1e7 }).trim()
const lncli = (node: string, ...args: string[]): any =>
  JSON.parse(sh('docker', ['exec', node, 'lncli', '--network=regtest', ...args]) || '{}')
const mine = (n: number) => sh('node', [`${REGTEST_DIR}/regtest.mjs`, 'mine', String(n)])
const payStatus = (node: string, hash: string): string | undefined =>
  lncli(node, 'listpayments', '--include_incomplete', '--max_payments', '100').payments.find(
    (p: any) => p.payment_hash === hash,
  )?.status

let PASS = 0
let FAIL = 0
const check = (cond: boolean, label: string) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`)
  cond ? PASS++ : FAIL++
}
async function waitUntil(fn: () => Promise<boolean> | boolean, what: string, ms = 90_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(1000)
  }
  console.log(`  … timed out waiting for ${what}`)
  return false
}

async function newWallet() {
  const identity = SingleKey.fromPrivateKey(randomBytes(32))
  const wallet = await Wallet.create({
    identity,
    arkProvider: new RestOperatorProvider(ARKD_URL),
    onchainProvider: new EsploraProvider(ESPLORA_URL, { forcePolling: true, pollingInterval: 2000 }),
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: false,
  } as never)
  const address = await wallet.getAddress()
  return { wallet, identity, xonly: toXOnly(await identity.xOnlyPublicKey()), address, ark: ArkAddress.decode(address) }
}

function faucet(address: string, amount: number) {
  const note = sh('docker', ['exec', 'arkd', 'arkd', 'note', '--amount', String(amount + 10_000)])
  sh('docker', ['exec', 'arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret'])
  sh('docker', ['exec', 'arkd', 'ark', 'send', '--to', address, '--amount', String(amount), '--password', 'secret'])
}

async function fundShared(funder: Wallet, indexer: RestIndexerProvider, script: AtomicVtxoScript, serverXOnly: Uint8Array, value: number): Promise<SharedVtxo> {
  const address = script.address(HRP, serverXOnly).encode()
  const pk = enc(script.pkScript)
  await funder.send({ address, amount: value })
  for (let i = 0; i < 30; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [pk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === value)
    if (v) return { txid: v.txid, vout: v.vout, value: v.value, script }
    await sleep(500)
  }
  throw new Error(`shared vtxo (value=${value}) never appeared`)
}

async function holds(indexer: RestIndexerProvider, addr: ArkAddress, value: number, recoverable: boolean): Promise<boolean> {
  const pk = enc(addr.pkScript)
  const { vtxos } = await indexer.getVtxos({ scripts: [pk], ...(recoverable ? { recoverableOnly: true } : { spendableOnly: true }) })
  return vtxos.some((v) => v.value === value && !v.isSpent)
}

/** Server-side preimage harvest (port of boltz extractPreimageFromClaim, SDK Transaction). */
async function harvestPreimage(indexer: RestIndexerProvider, shared: SharedVtxo, paymentHash: Uint8Array): Promise<Uint8Array | undefined> {
  const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid: shared.txid, vout: shared.vout }] })
  const spentBy = vtxos[0]?.spentBy
  if (!spentBy) return undefined
  const { txs } = await indexer.getVirtualTxs([spentBy])
  for (const b64 of txs) {
    const tx = Transaction.fromPSBT(base64.decode(b64))
    if (tx.id !== spentBy) continue
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i)
      if (!inp.txid || enc(inp.txid) !== shared.txid || inp.index !== shared.vout) continue
      const cands: Uint8Array[] = []
      try {
        for (const w of getArkPsbtFields(tx, i, ConditionWitness)) cands.push(...w)
      } catch {}
      if (inp.finalScriptWitness) cands.push(...inp.finalScriptWitness)
      for (const c of cands) if (c.length === 32 && enc(sha256(c)) === enc(paymentHash)) return c
    }
  }
  return undefined
}

async function main() {
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnrollScript(info.checkpointTapscript)
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  const a = 21
  console.log(`no-Boltz atomic sub-dust over real LN — arkd ${(info as any).version ?? ''} dust=${dust} a=${a}\n`)

  const U = await newWallet() // the bridge user
  const S = await newWallet() // the swap server (replaces boltz+fulmine)
  faucet(U.address, 100_000)
  faucet(S.address, 100_000)
  await waitUntil(async () => (await U.wallet.getBalance()).available >= 100_000 && (await S.wallet.getBalance()).available >= 100_000, 'faucet')
  const mk = (funder: Uint8Array, claimer: Uint8Array, h: Uint8Array, T: bigint) =>
    new AtomicVtxoScript({ funder, claimer, server: serverXOnly, paymentHash: h, refundLocktime: T, exitDelay: d })
  const all = (addr: ArkAddress, V: number): AtomicOutput[] => [{ script: addr.pkScript, amount: BigInt(V) }]

  // ── 1. receive OK ─────────────────────────────────────────────────────────
  console.log('1. RECEIVE (LN -> Ark, a=21) — success path')
  {
    const P = randomBytes(32)
    const H = sha256(P)
    const inv = lncli('lnd', 'addholdinvoice', enc(H), '--amt', String(a), '--expiry', '600')
    const payer = spawn('docker', ['exec', 'lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', inv.payment_request], { stdio: 'ignore' })
    const held = await waitUntil(() => lncli('lnd', 'lookupinvoice', enc(H)).state === 'ACCEPTED', 'HTLC held')
    check(held, 'payer HTLC is HELD at the server (invoice ACCEPTED, not settled)')
    const V = dust + a
    const shared = await fundShared(S.wallet, indexer, mk(S.xonly, U.xonly, H, nowSecs() + 3600n), serverXOnly, V)
    const split = computeClaimSplit({ funderAddress: S.ark, claimerAddress: U.ark, fundingValue: V, amount: a, dust })
    const presig = await presignClaim(shared, split.outputs, unroll, S.identity)
    check(payStatus('lnd-peer', enc(H)) === 'IN_FLIGHT', 'payer still IN_FLIGHT before the user reveals P')
    const claimTxid = await finishClaim(shared, split.outputs, unroll, presig, U.identity, P, ark)
    check(!!claimTxid, `user claimed via the presigned leaf (arkTxid ${claimTxid.slice(0, 12)}…)`)
    check(await waitUntil(() => holds(indexer, U.ark, a, true), 'user sub-dust'), `user holds the sub-dust a=${a}`)
    const harvested = await harvestPreimage(indexer, shared, H)
    check(!!harvested && enc(harvested) === enc(P), 'server harvested P from the claim tx (no trust in the user)')
    if (harvested) lncli('lnd', 'settleinvoice', enc(harvested))
    check(await waitUntil(() => payStatus('lnd-peer', enc(H)) === 'SUCCEEDED', 'payer success'), "payer's payment SUCCEEDED")
    check(lncli('lnd', 'lookupinvoice', enc(H)).state === 'SETTLED', 'server invoice SETTLED')
    payer.kill()
  }

  // ── 2. send OK ────────────────────────────────────────────────────────────
  console.log('\n2. SEND (Ark -> LN, a=21) — success path')
  {
    const fee = 1
    const inv = lncli('lnd-peer', 'addinvoice', '--amt', String(a))
    const H = hex.decode(inv.r_hash)
    const V = dust + a + fee
    const shared = await fundShared(U.wallet, indexer, mk(U.xonly, S.xonly, H, nowSecs() + 3600n), serverXOnly, V)
    const split = computeClaimSplit({ funderAddress: U.ark, claimerAddress: S.ark, fundingValue: V, amount: a + fee, dust })
    const presig = await presignClaim(shared, split.outputs, unroll, U.identity)
    // server: (would verify presig first — finishClaim re-verifies) then pay
    const pay = lncli('lnd', 'payinvoice', '--force', '--json', inv.payment_request)
    check(pay.status === 'SUCCEEDED', `server paid the payee's ${a}-sat invoice over LN`)
    const P = hex.decode(pay.payment_preimage)
    const claimTxid = await finishClaim(shared, split.outputs, unroll, presig, S.identity, P, ark)
    check(!!claimTxid, `server claimed a+fee with the learned P (arkTxid ${claimTxid.slice(0, 12)}…)`)
    check(lncli('lnd-peer', 'lookupinvoice', inv.r_hash).state === 'SETTLED', 'payee invoice SETTLED')
    check(await waitUntil(() => holds(indexer, S.ark, a + fee, true), 'server a+fee'), `server holds a+fee=${a + fee}`)
    check(await waitUntil(() => holds(indexer, U.ark, V - a - fee, false), 'user change'), `user got change ${V - a - fee} back`)
  }

  // ── 3. send FAIL → cancel ─────────────────────────────────────────────────
  console.log('\n3. SEND — LN failure -> presigned cooperative cancel')
  {
    const inv = lncli('lnd-peer', 'addinvoice', '--amt', String(a))
    lncli('lnd-peer', 'cancelinvoice', inv.r_hash) // payee will reject the HTLC
    const H = hex.decode(inv.r_hash)
    const V = dust + a + 1
    const shared = await fundShared(U.wallet, indexer, mk(U.xonly, S.xonly, H, nowSecs() + 3600n), serverXOnly, V)
    const cancelPresig = await presignCancel(shared, all(U.ark, V), unroll, U.identity)
    let failed = false
    try {
      const pay = lncli('lnd', 'payinvoice', '--force', '--json', inv.payment_request)
      failed = pay.status === 'FAILED'
    } catch {
      failed = true
    }
    check(failed, 'server payment FAILED terminally (no preimage learned)')
    const txid = await finishCancel(shared, all(U.ark, V), unroll, cancelPresig, S.identity, ark)
    check(!!txid, `cancel leaf (F+C+server, no timelock) completed (arkTxid ${txid.slice(0, 12)}…)`)
    check(await waitUntil(() => holds(indexer, U.ark, V, false), 'user refund'), `user recovered the full ${V} immediately`)
  }

  // ── 4. receive FAIL → refund ──────────────────────────────────────────────
  console.log('\n4. RECEIVE — user never claims -> CLTV refund + hold cancel')
  {
    const U2 = await newWallet() // fresh claimer: scenario 1 already left a 21-sat vtxo on U
    const P = randomBytes(32)
    const H = sha256(P)
    const inv = lncli('lnd', 'addholdinvoice', enc(H), '--amt', String(a), '--expiry', '600')
    const payer = spawn('docker', ['exec', 'lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', inv.payment_request], { stdio: 'ignore' })
    check(await waitUntil(() => lncli('lnd', 'lookupinvoice', enc(H)).state === 'ACCEPTED', 'HTLC held'), 'payer HTLC held')
    const V = dust + a
    const T = nowSecs() + 20n
    const shared = await fundShared(S.wallet, indexer, mk(S.xonly, U2.xonly, H, T), serverXOnly, V)
    // the user disappears: no claim. Wait out T on the chain's clock (MTP).
    await sleep(25_000)
    mine(12)
    const txid = await refundSpend(shared, all(S.ark, V), unroll, S.identity, ark)
    check(!!txid, `server refunded its funding via the CLTV leaf (arkTxid ${txid.slice(0, 12)}…)`)
    lncli('lnd', 'cancelinvoice', enc(H))
    check(await waitUntil(() => payStatus('lnd-peer', enc(H)) === 'FAILED', 'payer failed'), "payer's HTLC released (payment FAILED, payer keeps funds)")
    check(!(await holds(indexer, U2.ark, a, true)), 'user received nothing (nothing was taken from the payer)')
    payer.kill()
  }

  console.log(`\n${'─'.repeat(60)}\nverdict: ${PASS} passed, ${FAIL} failed`)
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
