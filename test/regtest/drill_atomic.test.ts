import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { hex } from '@scure/base'
import {
  DefaultVtxo,
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
  type ArkTxInput,
} from '@arkade-os/sdk'
import {
  AtomicVtxoScript,
  computeClaimSplit,
  finishClaim,
  fundShared,
  presignClaim,
  serverUnrollScript,
  SqliteAtomicSwapRepository,
  SwapDirection,
  type SharedVtxo,
} from '../../src/atomic'
import { driveAtomicReceive, issueAtomicReceive } from '../../src/atomic/receive'
import { resumeAtomicSends } from '../../src/atomic/send'
import { openDatabase } from '../../src/db'
import { reconcileAtomicReceives } from '../../src/ln_receive'
import { LnSendUnresolved, sendLightning } from '../../src/ln_send'
import { ArkSigner, hrpOf } from '../../subdustd/ark/signer'

// The atomic sub-dust drills (SM-51), moved off the Boltz fork onto subdustd —
// the harness container, so "restart the swap server" is a real process
// restart. These four drive the BRIDGE client (src/atomic) against it; the
// three purely server-side drills (init F17/F10, harvest F1, refund F2/F16)
// live in subdustd_receive / subdustd_scan / subdustd_send, which exercise the
// same scenarios against the same code. Mapping of all 41 original checks:
// SOLVER_MIGRATION_PLAN.md SM-51.
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/drill_atomic.test.ts

const ARKD = process.env.SUBDUSTD_ARKD_URL
const SUBDUSTD = process.env.SUBDUSTD_URL
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'

const sh = (container: string, ...args: string[]) =>
  execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const ln = (container: string, ...args: string[]): any => JSON.parse(sh(container, 'lncli', '--network=regtest', ...args))
const peer = (...a: string[]) => ln('lnd-peer', ...a)
const lnd = (...a: string[]) => ln('lnd', ...a)
const sha256 = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 120_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    let v: T | undefined
    try {
      v = await fn()
    } catch {
      v = undefined // a transient read during a restart
    }
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const healthy = async () => (await fetch(`${SUBDUSTD}/healthz`).then((r) => r.ok).catch(() => false)) || undefined
const payers: ChildProcess[] = []
const peerPays = (bolt11: string) =>
  payers.push(spawn('docker', ['exec', 'lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', bolt11], { stdio: 'ignore' }))
const getJson = async (path: string) => (await (await fetch(`${SUBDUSTD}${path}`)).json()) as any
const postJson = async (path: string, body: unknown) => {
  const res = await fetch(`${SUBDUSTD}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any }
}
const arkFund = (address: string, amount: number) => {
  const note = sh('arkd', 'arkd', 'note', '--amount', String(amount + 1000))
  sh('arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
  sh('arkd', 'ark', 'send', '--to', address, '--amount', String(amount), '--password', 'secret')
}

describe.skipIf(!ARKD || !SUBDUSTD)('atomic drills (bridge client × subdustd) on regtest', () => {
  let db: Database
  const tl = (d: bigint) => ({ type: d >= 512n ? ('seconds' as const) : ('blocks' as const), value: d })

  beforeAll(async () => {
    db = openDatabase(join(mkdtempSync(join(tmpdir(), 'drill-atomic-')), 'bridge.sqlite'))
    await waitFor('subdustd up', healthy, 60_000)
  }, 120_000)

  afterAll(() => {
    for (const p of payers) p.kill()
  })

  // converge (F12): the bridge claims but "crashes" before settle; subdustd's
  // scan harvests the preimage and settles (F1). The bridge comes back with a
  // row behind ('funded') and a server already 'settled': the real
  // driveAtomicReceive must converge to settled and report it (the receipt
  // fires), not poll forever.
  test('converge (F12): a bridge behind a settled swap converges and reports settled', async () => {
    const ark = new RestArkProvider(ARKD!)
    const info = await ark.getInfo()
    const bridge = SingleKey.fromPrivateKey(randomBytes(32))
    const deps = { identity: bridge, arkServerUrl: ARKD!, db, subdustdUrl: SUBDUSTD! }
    const r = await issueAtomicReceive(deps, 21)
    expect(r.invoice.startsWith('ln')).toBe(true) // 1: init ok
    peerPays(r.invoice)
    const st = await waitFor('funded + presigned', async () => {
      const s = await getJson(`/v2/subdust/atomic/receive/status?swapId=${r.swapId}`)
      return s.state === 'funded' && s.presigs ? s : undefined
    })
    expect(st.state).toBe('funded') // 2: funded + presigned

    // Claim by hand (revealing the preimage) and withhold settle — the crash.
    const server = hex.decode(info.signerPubkey).subarray(1)
    const d = BigInt(st.exitDelay)
    const peerD = st.boltzScriptDelay !== undefined ? BigInt(st.boltzScriptDelay) : d
    const funder = hex.decode(st.boltzPubkey)
    const claimer = await bridge.xOnlyPublicKey()
    const script = new AtomicVtxoScript({
      funder,
      claimer,
      server,
      paymentHash: hex.decode(r.paymentHash),
      refundLocktime: BigInt(st.refundLocktime),
      exitDelay: d,
    })
    const [txid, vout] = (st.fundingOutpoint as string).split(':')
    const v = (await new RestIndexerProvider(ARKD!).getVtxos({ scripts: [hex.encode(script.pkScript)], spendableOnly: true })).vtxos[0]!
    const shared: SharedVtxo = { txid: txid!, vout: Number(vout), value: v.value, script }
    const hrp = 'tark'
    const split = computeClaimSplit({
      funderAddress: new DefaultVtxo.Script({ pubKey: funder, serverPubKey: server, csvTimelock: tl(peerD) }).address(hrp, server),
      claimerAddress: new DefaultVtxo.Script({ pubKey: claimer, serverPubKey: server, csvTimelock: tl(d) }).address(hrp, server),
      fundingValue: v.value,
      amount: 21,
      dust: Number(info.dust),
    })
    await finishClaim(shared, split.outputs, serverUnrollScript(info.checkpointTapscript), st.presigs, bridge, hex.decode(new SqliteAtomicSwapRepository(db).get(r.swapId)!.preimage!), ark)

    await waitFor('subdustd to harvest and settle', async () => {
      const s = await getJson(`/v2/subdust/atomic/receive/status?swapId=${r.swapId}`)
      return s.state === 'settled' || undefined
    }, 150_000)
    expect(lnd('lookupinvoice', r.paymentHash).state).toBe('SETTLED') // 3+4: settled, hold invoice SETTLED

    // The behind row: recorded funded before the crash.
    const repo = new SqliteAtomicSwapRepository(db)
    repo.setFundingOutpoint(r.swapId, st.fundingOutpoint)
    repo.transition(r.swapId, 'funded')
    expect(await driveAtomicReceive(deps, r.swapId)).toBe(true) // 5: reports settled
    expect(repo.get(r.swapId)?.state).toBe('settled') // 6: converged
  }, 300_000)

  // invoice (F14), as a real restart: subdustd is down when the payer pays.
  // The held HTLC waits in LND; the restarted subdustd's boot pass funds it and
  // the bridge's reconcile carries the receive to settled.
  test('invoice (F14): the payer pays while subdustd is down; after the restart the bridge receive settles', async () => {
    const bridge = SingleKey.fromPrivateKey(randomBytes(32))
    const wallet = { identity: bridge } as never
    const r = await issueAtomicReceive({ identity: bridge, arkServerUrl: ARKD!, db, subdustdUrl: SUBDUSTD! }, 21)
    expect(r.swapId).toBeTruthy() // 1: init ok
    execFileSync('docker', ['stop', 'subdustd'])
    try {
      peerPays(r.invoice)
      await waitFor('the payer HTLC held at LND', () => (lnd('lookupinvoice', r.paymentHash).state === 'ACCEPTED' ? true : undefined), 60_000)
    } finally {
      execFileSync('docker', ['start', 'subdustd'])
    }
    expect(await waitFor('subdustd back', healthy, 60_000)).toBe(true) // 2: back up
    await waitFor('the receive to settle through the bridge reconcile', async () => {
      await reconcileAtomicReceives({ wallet, subdustdUrl: SUBDUSTD!, arkServerUrl: ARKD!, db })
      return new SqliteAtomicSwapRepository(db).get(r.swapId)?.state === 'settled' || undefined
    }, 180_000)
    expect(lnd('lookupinvoice', r.paymentHash).state).toBe('SETTLED') // 3: re-funded → settled, payer paid
  }, 300_000)

  // concurrent (F3): two /send/fund for one funded swap at the same instant.
  // Exactly one may pay; the other is refused (swap lock / CAS). LN sees one
  // payment.
  test('concurrent (F3): two simultaneous /send/fund — exactly one pays, once', async () => {
    const funder = new ArkSigner(randomBytes(32), ARKD!)
    arkFund((await funder.receiveAddress()).encode(), 2000)
    const coin = await waitFor('funder coin', async () => (await funder.ownVtxos())[0]) // 1: funder funded
    const inv = peer('addinvoice', '--amt', '21')
    const init = await postJson('/v2/subdust/atomic/send/init', { invoice: inv.payment_request, userPubkey: hex.encode(await funder.xOnlyPublicKey()) })
    expect(init.status).toBe(200) // 2: init ok
    const i = init.body
    const info = await funder.getInfo()
    const server = await funder.serverXOnly()
    const unroll = await funder.serverUnroll()
    const script = new AtomicVtxoScript({
      funder: await funder.xOnlyPublicKey(),
      claimer: hex.decode(i.boltzPubkey),
      server,
      paymentHash: hex.decode(inv.r_hash),
      refundLocktime: BigInt(i.refundLocktime),
      exitDelay: BigInt(i.exitDelay),
    })
    const self = await funder.selfScript()
    const inputs: ArkTxInput[] = [{ txid: coin.txid, vout: coin.vout, value: coin.value, tapLeafScript: self.forfeit(), tapTree: self.encode() }]
    const outpoint = await fundShared(inputs, [{ script: script.pkScript, amount: BigInt(coin.value) }], unroll, funder.identity, funder.ark)
    const shared: SharedVtxo = { txid: outpoint.txid, vout: outpoint.vout, value: coin.value, script }
    const peerD = i.boltzScriptDelay !== undefined ? BigInt(i.boltzScriptDelay) : BigInt(i.exitDelay)
    const split = computeClaimSplit({
      funderAddress: await funder.receiveAddress(),
      claimerAddress: new DefaultVtxo.Script({ pubKey: hex.decode(i.boltzPubkey), serverPubKey: server, csvTimelock: tl(peerD) }).address(hrpOf(info), server),
      fundingValue: coin.value,
      amount: 21,
      dust: Number(i.dust),
      feeSats: i.feeSats ?? 0,
    })
    const presigs = await presignClaim(shared, split.outputs, unroll, funder.identity)
    expect(presigs.arkTx).toBeTruthy() // 3: funded + presigned
    const body = { swapId: i.swapId, fundingOutpoint: `${outpoint.txid}:${outpoint.vout}`, presigs }
    const results = await Promise.all([postJson('/v2/subdust/atomic/send/fund', body), postJson('/v2/subdust/atomic/send/fund', body)])
    const claimed = results.filter((x) => x.body.status === 'claimed')
    const refused = results.filter((x) => x.body.status !== 'claimed')
    expect(claimed).toHaveLength(1) // 4: exactly one claimed
    expect(refused).toHaveLength(1) // 5: exactly one refused
    expect(String(refused[0]!.body.error ?? '').length).toBeGreaterThan(0)
    expect(sha256(claimed[0]!.body.preimage)).toBe(inv.r_hash) // 6: the real preimage
    expect(peer('lookupinvoice', inv.r_hash).state).toBe('SETTLED') // 7: paid (once — LND refuses a second)
  }, 300_000)

  // send-resume (F6/F13), as a real restart: subdustd dies while its LN payment
  // is in flight. The bridge's send call breaks with the swap ln_inflight — the
  // NWC layer must call that unresolved, not failed. The restarted subdustd
  // resolves the payment from LND once the payee settles and claims; the
  // bridge's resume converges to claimed with the preimage.
  test('send-resume (F6/F13): subdustd restarts mid-payment; the send is unresolved, then resumes to claimed', async () => {
    const identity = SingleKey.fromPrivateKey(randomBytes(32))
    const wallet = await Wallet.create({
      identity,
      operatorProvider: new RestOperatorProvider(ARKD!),
      indexerProvider: new RestIndexerProvider(ARKD!),
      onchainProvider: new EsploraProvider(ESPLORA, { forcePolling: true, pollingInterval: 2000 }),
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    try {
      arkFund(await wallet.getAddress(), 5000)
      await waitFor('wallet funded', async () => ((await wallet.getBalance()).available >= 5000 ? true : undefined)) // 1
      const preimage = randomBytes(32).toString('hex')
      const hash = sha256(preimage)
      const bolt11 = peer('addholdinvoice', hash, '--amt', '21').payment_request
      const deps = { wallet, arkServerUrl: ARKD!, db, notify: undefined }
      const lightning = { solver: undefined as never, subdustdUrl: SUBDUSTD! }
      const sending = sendLightning({ ...deps, lightning }, bolt11).catch((e) => e)
      await waitFor('our HTLC held by the payee', () => (peer('lookupinvoice', hash).state === 'ACCEPTED' ? true : undefined), 90_000)
      const repo = new SqliteAtomicSwapRepository(db)
      const row = repo.getByPaymentHash(hash)!
      expect(row.direction).toBe(SwapDirection.Send) // 2: init ok
      expect(row.fundingOutpoint).toBeTruthy() // 3: funded + presigned
      execFileSync('docker', ['restart', 'subdustd'])
      const outcome = await sending
      expect(outcome).toBeInstanceOf(LnSendUnresolved) // the NWC row would stay pending
      expect(repo.get(row.id)?.state).toBe('ln_inflight') // 4: stuck paid-in-flight, unclaimed
      await waitFor('subdustd back', healthy, 60_000)
      peer('settleinvoice', preimage)
      await waitFor('the bridge resume to converge on claimed', async () => {
        await resumeAtomicSends({ ...deps, subdustdUrl: SUBDUSTD! })
        return repo.get(row.id)?.state === 'claimed' || undefined
      }, 180_000) // 5: claimed via the restarted server's resolve, no operator help
      const [txid, vout] = row.fundingOutpoint!.split(':')
      const shared = await new RestIndexerProvider(ARKD!).getVtxos({ outpoints: [{ txid: txid!, vout: Number(vout) }] })
      expect(shared.vtxos[0]?.isSpent).toBe(true) // 6: the funding consumed by the claim
      expect(sha256(repo.get(row.id)!.preimage!)).toBe(hash) // 7: recovered preimage matches
    } finally {
      await wallet.dispose()
    }
  }, 400_000)
})
