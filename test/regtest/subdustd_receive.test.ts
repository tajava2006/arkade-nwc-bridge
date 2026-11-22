import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
import { DefaultVtxo, SingleKey, type ArkTxInput } from '@arkade-os/sdk'
import { AtomicVtxoScript, computeClaimSplit, finishClaim, fundShared, type SharedVtxo } from '../../src/atomic/index.ts'
import { ReceiveService, receiveFinalCltv } from '../../subdustd/api/receive.ts'
import { SwapLocks } from '../../subdustd/api/http_error.ts'
import { ArkSigner, hrpOf } from '../../subdustd/ark/signer.ts'
import type { SubdustKnobs } from '../../subdustd/config.ts'
import { startHttp } from '../../subdustd/http.ts'
import { LndClient } from '../../subdustd/lnd/client.ts'
import { createLogger } from '../../subdustd/log.ts'
import { SwapStore } from '../../subdustd/store.ts'

// subdustd's receive endpoints end to end on regtest: the peer LND pays our
// hold invoice, subdustd funds a shared vtxo from its float and presigns, a
// receiver claims with the preimage over HTTP exactly as the bridge does, and
// subdustd settles.
//
//   SUBDUSTD_ARKD_URL=http://localhost:7070 SUBDUSTD_LND_CERT=… SUBDUSTD_LND_MACAROON=… \
//     bun test test/regtest/subdustd_receive.test.ts

const ARKD_URL = process.env.SUBDUSTD_ARKD_URL
const CERT = process.env.SUBDUSTD_LND_CERT
const MACAROON = process.env.SUBDUSTD_LND_MACAROON
const SOCKET = process.env.SUBDUSTD_LND_SOCKET ?? '127.0.0.1:10009'
const PEER = process.env.SUBDUSTD_LND_PEER_CONTAINER ?? 'lnd-peer'

const sh = (container: string, ...args: string[]) =>
  execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const peer = (...args: string[]): any => JSON.parse(sh(PEER, 'lncli', '--network=regtest', ...args))
const sha256 = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 60_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(400)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const payers: ChildProcess[] = []
const peerPays = (bolt11: string) => {
  payers.push(spawn('docker', ['exec', PEER, 'lncli', '--network=regtest', 'payinvoice', '--force', bolt11], { stdio: 'ignore' }))
}
const peerPaymentStatus = (hash: string): string | undefined =>
  peer('listpayments', '--include_incomplete', '--max_payments', '300').payments.find((p: any) => p.payment_hash === hash)?.status

const knobs: SubdustKnobs = { sendWindowSecs: 3_600, receiveWindowSecs: 600, payMarginSecs: 60, blockTimeSecs: 30, sendFeePercent: 0.5 }

const topUp = (address: string, amount: number) => {
  const note = sh('arkd', 'arkd', 'note', '--amount', String(amount + 1000))
  sh('arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
  sh('arkd', 'ark', 'send', '--to', address, '--amount', String(amount), '--password', 'secret')
}

describe.skipIf(!ARKD_URL || !CERT || !MACAROON)('subdustd receive endpoints on regtest', () => {
  let store: SwapStore
  let lnd: LndClient
  let signer: ArkSigner
  let locks: SwapLocks
  let service: ReceiveService
  let server: ReturnType<typeof startHttp>
  let base: string
  const log = createLogger('error')

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}/v2/subdust/atomic/receive/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as any }
  }
  const status = async (swapId: string) => (await (await fetch(`${base}/v2/subdust/atomic/receive/status?swapId=${swapId}`)).json()) as any

  const newReceiver = () => {
    const preimage = randomBytes(32).toString('hex')
    return { user: SingleKey.fromPrivateKey(randomBytes(32)), preimage, hash: sha256(preimage) }
  }

  /** The bridge's claim: rebuild script + split from the status alone, verify, finish with the preimage. */
  const claim = async (st: any, r: ReturnType<typeof newReceiver>, amount: number) => {
    const info = await signer.getInfo()
    const server = await signer.serverXOnly()
    const userXOnly = await r.user.xOnlyPublicKey()
    const d = BigInt(st.exitDelay)
    const bd = BigInt(st.boltzScriptDelay)
    const script = new AtomicVtxoScript({
      funder: hex.decode(st.boltzPubkey),
      claimer: userXOnly,
      server,
      paymentHash: hex.decode(r.hash),
      refundLocktime: BigInt(st.refundLocktime),
      exitDelay: d,
    })
    const [txid, vout] = st.fundingOutpoint.split(':')
    const { vtxos } = await signer.indexer.getVtxos({ outpoints: [{ txid, vout: Number(vout) }] })
    const shared: SharedVtxo = { txid, vout: Number(vout), value: vtxos[0]!.value, script }
    const t = (v: bigint) => ({ type: v >= 512n ? ('seconds' as const) : ('blocks' as const), value: v })
    const split = computeClaimSplit({
      funderAddress: new DefaultVtxo.Script({ pubKey: hex.decode(st.boltzPubkey), serverPubKey: server, csvTimelock: t(bd) }).address(hrpOf(info), server),
      claimerAddress: new DefaultVtxo.Script({ pubKey: userXOnly, serverPubKey: server, csvTimelock: t(d) }).address(hrpOf(info), server),
      fundingValue: shared.value,
      amount,
      dust: Number(info.dust),
    })
    const claimTxid = await finishClaim(shared, split.outputs, await signer.serverUnroll(), st.presigs, r.user, hex.decode(r.preimage), signer.ark)
    return { claimTxid, shared }
  }

  beforeAll(async () => {
    store = SwapStore.open(join(mkdtempSync(join(tmpdir(), 'subdustd-recv-')), 'swaps.sqlite'))
    lnd = new LndClient({ socket: SOCKET, certPath: CERT!, macaroonPath: MACAROON! })
    signer = new ArkSigner(randomBytes(32), ARKD_URL!)
    locks = new SwapLocks()
    service = new ReceiveService({ store, signer, lnd, knobs, log, locks, emit: () => {} })
    server = startHttp({ http: { host: '127.0.0.1', port: 0 } } as never, log, { receive: service })
    base = `http://127.0.0.1:${server.port}`
    const addr = (await signer.receiveAddress()).encode()
    for (let i = 0; i < 5; i++) topUp(addr, 1_000)
    await waitFor('the subdustd float', async () => ((await signer.ownVtxos()).length >= 5 ? true : undefined))
  }, 240_000)

  afterAll(() => {
    for (const p of payers) p.kill()
    service?.close()
    server?.stop(true)
    lnd?.close()
    store?.close()
  })

  test('init: hold invoice with the window-derived final cltv (F10) and description hash; idempotent (F17); refusals', async () => {
    const r = newReceiver()
    const user = hex.encode(await r.user.xOnlyPublicKey())
    const descriptionHash = sha256('cd'.repeat(16))
    const a = await post('init', { amount: 21, paymentHash: r.hash, userPubkey: user, descriptionHash })
    expect(a.status).toBe(200)
    expect(Object.keys(a.body).sort()).toEqual(['invoice', 'swapId'])
    const decoded = await lnd.decodeInvoice(a.body.invoice)
    expect(decoded).toMatchObject({ valueSat: 21, paymentHash: r.hash, descriptionHash, expirySecs: knobs.receiveWindowSecs })
    expect(decoded.cltvExpiry).toBe(receiveFinalCltv(knobs))
    expect(decoded.cltvExpiry).toBe(Math.ceil(600 / 30) + 18)
    expect((await post('init', { amount: 21, paymentHash: r.hash, userPubkey: user })).body).toEqual(a.body)

    // D10: any amount; a plain description becomes the memo, never beside a hash.
    const big = newReceiver()
    const b = await post('init', { amount: 400, paymentHash: big.hash, userPubkey: user, description: 'tea' })
    expect(b.status).toBe(200)
    expect(await lnd.decodeInvoice(b.body.invoice)).toMatchObject({ valueSat: 400, paymentHash: big.hash })
    await lnd.cancelHoldInvoice(big.hash)
    expect((await post('init', { amount: 400, paymentHash: newReceiver().hash, userPubkey: user, description: 'x', descriptionHash })).body.error).toContain('not both')
    expect((await post('init', { amount: 21, paymentHash: 'xyz', userPubkey: user })).body.error).toBe('invalid parameter: paymentHash')
    expect((await fetch(`${base}/v2/subdust/atomic/receive/status?swapId=nope`)).status).toBe(400)
    await lnd.cancelHoldInvoice(r.hash)
  }, 60_000)

  test('init refuses (503) when the float cannot fund — no unpayable invoice is ever issued', async () => {
    const empty = new ReceiveService({ store, signer: new ArkSigner(randomBytes(32), ARKD_URL!), lnd, knobs, log, locks, emit: () => {} })
    const r = newReceiver()
    const err = await empty.init({ amount: 21, paymentHash: r.hash, userPubkey: hex.encode(await r.user.xOnlyPublicKey()) }).catch((e) => e)
    expect(err.status).toBe(503)
    expect(err.message).toContain('holds no vtxo')
    expect(store.getByPaymentHash(r.hash)).toBeUndefined()
  })

  test('full receive: pay → funded (fast path) → claim with the preimage → settle; settle again is idempotent (F12)', async () => {
    const r = newReceiver()
    const init = await post('init', { amount: 21, paymentHash: r.hash, userPubkey: hex.encode(await r.user.xOnlyPublicKey()) })
    peerPays(init.body.invoice)
    const st = await waitFor('funded', async () => {
      const s = await status(init.body.swapId)
      return s.state === 'funded' ? s : undefined
    })
    expect(Object.keys(st).sort()).toEqual(['boltzPubkey', 'boltzScriptDelay', 'exitDelay', 'fundingOutpoint', 'presigs', 'refundLocktime', 'state'])
    const { claimTxid, shared } = await claim(st, r, 21)

    expect((await post('settle', { swapId: init.body.swapId, preimage: r.preimage })).body).toEqual({ settled: true })
    await waitFor('the payer to see SUCCEEDED', () => peerPaymentStatus(r.hash) === 'SUCCEEDED' || undefined)
    expect(store.get(init.body.swapId)).toMatchObject({ state: 'settled', preimage: r.preimage })
    expect((await post('settle', { swapId: init.body.swapId, preimage: r.preimage })).body).toEqual({ settled: true })
    // Our change (V − a) came back on our own script.
    const back = await waitFor('our change', async () => (await signer.ownVtxos()).find((v) => v.txid === claimTxid))
    expect(back.value).toBe(shared.value - 21)
  }, 120_000)

  test('F14: a restart loses the listener — the resume pass funds the held invoice', async () => {
    const before = new ReceiveService({ store, signer, lnd, knobs, log, locks, emit: () => {} })
    const r = newReceiver()
    const init = await before.init({ amount: 21, paymentHash: r.hash, userPubkey: hex.encode(await r.user.xOnlyPublicKey()) })
    before.close() // "restart": the in-memory subscription is gone
    peerPays(init.invoice)
    await waitFor('the HTLC held', async () => ((await lnd.lookupInvoice(r.hash)).state === 'ACCEPTED' ? true : undefined))
    expect(store.get(init.swapId)?.state).toBe('invoice_issued')
    const after = new ReceiveService({ store, signer, lnd, knobs, log, locks, emit: () => {} })
    await after.resumeInvoiceIssued(init.swapId)
    expect(store.get(init.swapId)?.state).toBe('funded')
    const st = await status(init.swapId)
    await claim(st, r, 21)
    expect((await post('settle', { swapId: init.swapId, preimage: r.preimage })).body).toEqual({ settled: true })
  }, 120_000)

  test('F14: a hold invoice cancelled before funding resolves to failed', async () => {
    const r = newReceiver()
    const init = await post('init', { amount: 21, paymentHash: r.hash, userPubkey: hex.encode(await r.user.xOnlyPublicKey()) })
    await lnd.cancelHoldInvoice(r.hash)
    await service.resumeInvoiceIssued(init.body.swapId)
    expect(store.get(init.body.swapId)?.state).toBe('failed')
  })

  test('settle refuses a wrong preimage and a swap that is not funded', async () => {
    const r = newReceiver()
    const init = await post('init', { amount: 21, paymentHash: r.hash, userPubkey: hex.encode(await r.user.xOnlyPublicKey()) })
    expect((await post('settle', { swapId: init.body.swapId, preimage: 'ab'.repeat(32) })).body.error).toBe('preimage does not match the invoice payment hash')
    expect((await post('settle', { swapId: init.body.swapId, preimage: r.preimage })).body.error).toContain('is invoice_issued, not settleable')
    await lnd.cancelHoldInvoice(r.hash)
  })

  test('a held HTLC we can no longer fund is cancelled at once (payer refunded), not held to timeout', async () => {
    const lone = new ArkSigner(randomBytes(32), ARKD_URL!)
    topUp((await lone.receiveAddress()).encode(), 1_000)
    const coin = await waitFor('its single coin', async () => (await lone.ownVtxos())[0])
    const svc = new ReceiveService({ store, signer: lone, lnd, knobs, log, locks, emit: () => {} })
    const r = newReceiver()
    const init = await svc.init({ amount: 21, paymentHash: r.hash, userPubkey: hex.encode(await r.user.xOnlyPublicKey()) })
    // Spend the only coin elsewhere before the payer pays.
    const self = await lone.selfScript()
    const away = (await signer.receiveAddress()).pkScript
    const inputs: ArkTxInput[] = [{ txid: coin.txid, vout: coin.vout, value: coin.value, tapLeafScript: self.forfeit(), tapTree: self.encode() }]
    await fundShared(inputs, [{ script: away, amount: BigInt(coin.value) }], await lone.serverUnroll(), lone.identity, lone.ark)
    await waitFor('the float empty', async () => ((await lone.ownVtxos()).length === 0 ? true : undefined))
    peerPays(init.invoice)
    await waitFor('failed', () => (store.get(init.swapId)?.state === 'failed' ? true : undefined))
    await waitFor('the payer refunded', () => peerPaymentStatus(r.hash) === 'FAILED' || undefined)
    svc.close()
  }, 120_000)
})
