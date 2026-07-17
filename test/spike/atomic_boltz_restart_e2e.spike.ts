// #14 drill — boltz mid-swap restart. The receive path parks real value in a
// shared vtxo boltz funded + pre-signed; if boltz restarts before the claimer
// settles, the swap must survive (boltz persists it in pg, not just in the
// htlc.accepted event). Proves the deploy-time restart (bump-stack rebuild)
// won't strand an in-flight receive.
//
//   arkade-regtest up (seconds mode) with BOLTZ_IMAGE=boltz-atomic:regtest
//   bun test/spike/atomic_boltz_restart_e2e.spike.ts

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  DefaultVtxo,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  type ArkInfo,
} from '@arkade-os/sdk'
import { SqliteAtomicSwapRepository } from '../../src/atomic'
import { issueAtomicReceive, driveAtomicReceive } from '../../src/atomic_receive'
import { openDatabase } from '../../src/db'

const ARKD_URL = 'http://localhost:7070'
const BOLTZ_URL = 'http://localhost:9069'
const ARK_PW = 'secret'
const HRP = 'tark'
const BOLTZ_KEY = '3820bf24c99fd1a1d20205e0237c73af9a0f998b6844aa1e87a09585354abe86'
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
async function boltzUp(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BOLTZ_URL}/v2/subdust/atomic/send/init`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      if (res.status === 400) return true // router alive (rejects empty body)
    } catch {
      /* still down */
    }
    await sleep(1000)
  }
  return false
}

async function main(): Promise<void> {
  console.log(`atomic boltz-RESTART e2e (#14) — mid-swap restart, boltz ${BOLTZ_URL}\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'atomic-restart-'))
  const db = openDatabase(join(scratch, 'bridge.sqlite'))
  const repo = new SqliteAtomicSwapRepository(db)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info: ArkInfo = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const d = info.unilateralExitDelay
  const tl = { type: d >= 512n ? ('seconds' as const) : ('blocks' as const), value: d }
  const a = 21

  // fund boltz's mini-wallet (funder on receive)
  const boltzKey = SingleKey.fromPrivateKey(hex.decode(BOLTZ_KEY))
  const boltzAddr = new DefaultVtxo.Script({ pubKey: toXOnly(await boltzKey.xOnlyPublicKey()), serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)
  regtest('ark', 'send', '--to', boltzAddr.encode(), '--amount', '100000', '--password', ARK_PW)
  regtest('mine', '1')
  await sleep(1500)

  // receiver bridge
  const idB = SingleKey.fromPrivateKey(randomBytes(32))
  const bridgeXOnly = toXOnly(await idB.xOnlyPublicKey())
  const bridgeAddr = new DefaultVtxo.Script({ pubKey: bridgeXOnly, serverPubKey: serverXOnly, csvTimelock: tl }).address(HRP, serverXOnly)
  const deps = { identity: idB, arkServerUrl: ARKD_URL, db, boltzApiUrl: BOLTZ_URL }

  const issued = await issueAtomicReceive(deps, a)
  check(!!issued.swapId, `receive issued (swap ${issued.swapId.slice(0, 8)}…)`)
  execFileSync('docker', ['exec', '-d', 'lnd', 'lncli', '--network=regtest', 'payinvoice', '--force', issued.invoice], { encoding: 'utf8' })
  console.log('  external payer paying the hold invoice…')

  // wait until boltz has funded + pre-signed (state persisted in pg)
  let funded = false
  for (let i = 0; i < 45 && !funded; i++) {
    const res = await fetch(`${BOLTZ_URL}/v2/subdust/atomic/receive/status?swapId=${issued.swapId}`)
    if (res.ok) funded = ((await res.json()) as { state: string }).state === 'funded'
    if (!funded) await sleep(1000)
  }
  check(funded, 'boltz funded + pre-signed the shared vtxo (state persisted)')

  // ── restart boltz mid-swap ──
  console.log('\n  🔄 restarting the boltz container mid-swap…')
  execFileSync('docker', ['restart', 'boltz'], { encoding: 'utf8' })
  const back = await boltzUp()
  check(back, 'boltz came back up')

  // status must survive the restart (read from pg, not the lost in-memory event)
  const res = await fetch(`${BOLTZ_URL}/v2/subdust/atomic/receive/status?swapId=${issued.swapId}`)
  const survived = res.ok && ((await res.json()) as { state: string }).state === 'funded'
  check(survived, 'swap still reads "funded" after restart (pg persistence held)')

  // claim + settle through the production driver — must complete post-restart
  let settled = false
  for (let i = 0; i < 45 && !settled; i++) {
    settled = await driveAtomicReceive(deps, issued.swapId)
    if (!settled) await sleep(1000)
  }
  check(settled, 'driveAtomicReceive claimed + settled AFTER the restart')
  check(repo.get(issued.swapId)?.state === 'settled', 'swap row = settled')

  const bridgePk = enc(bridgeAddr.pkScript)
  let received = false
  for (let i = 0; i < 20 && !received; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [bridgePk], recoverableOnly: true })
    received = vtxos.some((x) => x.value === a && !x.isSpent)
    if (!received) await sleep(500)
  }
  check(received, `receiver holds the sub-dust a=${a} — value survived the restart`)

  rmSync(scratch, { recursive: true, force: true })
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(FAIL === 0 ? '✅ MID-SWAP RESTART SAFE — boltz pg persistence carries the swap through a restart' : '❌ FAILURES')
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
