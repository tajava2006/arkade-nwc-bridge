import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
import { DefaultVtxo, getAllNormalizedVtxos, type ArkTxInput } from '@arkade-os/sdk'
import {
  AtomicVtxoScript,
  buildVhtlc,
  computeClaimSplit,
  fundShared,
  presignCancel,
  presignClaim,
  type SharedVtxo,
} from '../../src/atomic/index.ts'
import { SendService } from '../../subdustd/api/send.ts'
import { SwapLocks } from '../../subdustd/api/http_error.ts'
import { ArkSigner, hrpOf } from '../../subdustd/ark/signer.ts'
import type { SubdustKnobs } from '../../subdustd/config.ts'
import { LndClient, LndError } from '../../subdustd/lnd/client.ts'
import { createLogger } from '../../subdustd/log.ts'
import { startHttp } from '../../subdustd/http.ts'
import { SwapStore } from '../../subdustd/store.ts'

// subdustd's send endpoints end to end on regtest: real fork arkd, the
// subdustd LND (lnd) paying a peer (lnd-peer), and a key-only funder that
// speaks to subdustd over HTTP exactly as the bridge client does.
//
//   SUBDUSTD_ARKD_URL=http://localhost:7070 SUBDUSTD_LND_CERT=… SUBDUSTD_LND_MACAROON=… \
//     bun test test/regtest/subdustd_send.test.ts

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
const secret = () => {
  const preimage = randomBytes(32).toString('hex')
  return { preimage, hash: sha256(preimage) }
}
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 60_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(400)
  }
  throw new Error(`timeout waiting for ${what}`)
}

// The regtest drill knobs: 30s blocks keep the cltv budget ((3600 − 60) / 30 = 118) above the peer's final cltv.
const knobs: SubdustKnobs = { sendWindowSecs: 3_600, receiveWindowSecs: 60, payMarginSecs: 60, blockTimeSecs: 30, sendFeePercent: 0.5 }

describe.skipIf(!ARKD_URL || !CERT || !MACAROON)('subdustd send endpoints on regtest', () => {
  let store: SwapStore
  let lnd: LndClient
  let signer: ArkSigner
  let funder: ArkSigner
  let locks: SwapLocks
  let service: SendService
  let server: ReturnType<typeof startHttp>
  let base: string

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}/v2/subdust/atomic/send/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as any }
  }
  const status = async (swapId: string) =>
    (await (await fetch(`${base}/v2/subdust/atomic/send/status?swapId=${swapId}`)).json()) as any

  const topUpFunder = (amount: number) => {
    const note = sh('arkd', 'arkd', 'note', '--amount', String(amount + 1000))
    sh('arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
  }

  beforeAll(async () => {
    store = SwapStore.open(join(mkdtempSync(join(tmpdir(), 'subdustd-send-')), 'swaps.sqlite'))
    lnd = new LndClient({ socket: SOCKET, certPath: CERT!, macaroonPath: MACAROON! })
    signer = new ArkSigner(randomBytes(32), ARKD_URL!)
    funder = new ArkSigner(randomBytes(32), ARKD_URL!)
    locks = new SwapLocks()
    const log = createLogger('error')
    service = new SendService({ store, signer, lnd, knobs, log, locks, emit: () => {} })
    server = startHttp({ http: { host: '127.0.0.1', port: 0 } } as never, log, { send: service })
    base = `http://127.0.0.1:${server.port}`
    // The funder's float: a few 2,000-sat coins, one burned whole per swap.
    topUpFunder(12_000)
    const addr = (await funder.receiveAddress()).encode()
    for (let i = 0; i < 6; i++) sh('arkd', 'ark', 'send', '--to', addr, '--amount', '2000', '--password', 'secret')
    await waitFor('the funder float', async () => ((await funder.ownVtxos()).length >= 6 ? true : undefined))
  }, 180_000)

  afterAll(() => {
    server?.stop(true)
    lnd?.close()
    store?.close()
  })

  /**
   * The bridge's half of a send, up to fundable: init → fund the script subdustd
   * offered. A 4-leaf (sub-dust) burns a coin whole and presigns the claim; a
   * VHTLC (dust+) takes exactly a + fee with the change in the funding tx, and
   * needs no presig.
   */
  const prepare = async (invoice: string, minCoin = 0) => {
    const init = await post('init', { invoice, userPubkey: hex.encode(await funder.xOnlyPublicKey()) })
    expect(init.status).toBe(200)
    const i = init.body
    const info = await funder.getInfo()
    const server = await funder.serverXOnly()
    const unroll = await funder.serverUnroll()
    const decoded = await lnd.decodeInvoice(invoice)
    const decodedHash = decoded.paymentHash
    if (i.script === 'vhtlc') {
      const vscript = buildVhtlc({
        sender: await funder.xOnlyPublicKey(),
        receiver: hex.decode(i.boltzPubkey),
        server,
        paymentHash: hex.decode(decodedHash),
        timeouts: { refundLocktime: i.refundLocktime, ...i.vhtlc },
      })
      const V = decoded.valueSat + i.feeSats
      const coin = (await funder.ownVtxos()).find((v) => v.value >= Math.max(minCoin, V))!
      const self = await funder.selfScript()
      const change = coin.value - V
      const outputs = [
        { script: vscript.pkScript, amount: BigInt(V) },
        ...(change > 0 ? [{ script: (await funder.receiveAddress()).pkScript, amount: BigInt(change) }] : []),
      ]
      const inputs: ArkTxInput[] = [{ txid: coin.txid, vout: coin.vout, value: coin.value, tapLeafScript: self.forfeit(), tapTree: self.encode() }]
      const outpoint = await fundShared(inputs, outputs, unroll, funder.identity, funder.ark)
      const shared: SharedVtxo = { txid: outpoint.txid, vout: outpoint.vout, value: V, script: vscript }
      return { init: i, shared, presigs: undefined, unroll, hash: decodedHash, fundBody: { swapId: i.swapId, fundingOutpoint: `${shared.txid}:${shared.vout}` } }
    }
    const d = BigInt(i.exitDelay)
    const script = new AtomicVtxoScript({
      funder: await funder.xOnlyPublicKey(),
      claimer: hex.decode(i.boltzPubkey),
      server,
      paymentHash: hex.decode(decodedHash),
      refundLocktime: BigInt(i.refundLocktime),
      exitDelay: d,
    })
    const coin = (await funder.ownVtxos()).find((v) => v.value >= minCoin)!
    const self = await funder.selfScript()
    const inputs: ArkTxInput[] = [{ txid: coin.txid, vout: coin.vout, value: coin.value, tapLeafScript: self.forfeit(), tapTree: self.encode() }]
    const outpoint = await fundShared(inputs, [{ script: script.pkScript, amount: BigInt(coin.value) }], unroll, funder.identity, funder.ark)
    const shared: SharedVtxo = { txid: outpoint.txid, vout: outpoint.vout, value: coin.value, script }
    const bd = BigInt(i.boltzScriptDelay)
    const claimerAddress = new DefaultVtxo.Script({
      pubKey: hex.decode(i.boltzPubkey),
      serverPubKey: server,
      csvTimelock: { type: bd >= 512n ? 'seconds' : 'blocks', value: bd },
    }).address(hrpOf(info), server)
    const split = computeClaimSplit({
      funderAddress: await funder.receiveAddress(),
      claimerAddress,
      fundingValue: coin.value,
      amount: (await lnd.decodeInvoice(invoice)).valueSat,
      dust: Number(i.dust),
      feeSats: i.feeSats,
    })
    const presigs = await presignClaim(shared, split.outputs, unroll, funder.identity)
    return { init: i, shared, presigs, unroll, hash: decodedHash, fundBody: { swapId: i.swapId, fundingOutpoint: `${shared.txid}:${shared.vout}`, presigs } }
  }

  const cancelBody = async (p: Awaited<ReturnType<typeof prepare>>) => {
    const ours = await funder.receiveAddress()
    const outputs = [{ script: ours.pkScript, amount: BigInt(p.shared.value) }]
    return {
      swapId: p.init.swapId,
      fundingOutpoint: `${p.shared.txid}:${p.shared.vout}`,
      outputs: outputs.map((o) => ({ script: hex.encode(o.script), amount: Number(o.amount) })),
      presigs: await presignCancel(p.shared, outputs, p.unroll, funder.identity),
    }
  }

  test('init: shape, idempotent for an unfunded invoice (F17), any amount (D11), refuses garbage', async () => {
    const inv = peer('addinvoice', '--amt', '21')
    const user = hex.encode(await funder.xOnlyPublicKey())
    const a = await post('init', { invoice: inv.payment_request, userPubkey: user })
    expect(a.status).toBe(200)
    expect(Object.keys(a.body).sort()).toEqual(['boltzPubkey', 'boltzScriptDelay', 'dust', 'exitDelay', 'feeSats', 'refundLocktime', 'script', 'swapId', 'vtxoMin'])
    expect(a.body.script).toBe('atomic4') // 21 + 1 < dust
    expect(a.body.feeSats).toBe(1)
    expect(a.body.boltzScriptDelay).toBe(a.body.exitDelay)
    expect(a.body.refundLocktime - Date.now() / 1000).toBeLessThanOrEqual(knobs.sendWindowSecs)
    const again = await post('init', { invoice: inv.payment_request, userPubkey: user })
    expect(again.body.swapId).toBe(a.body.swapId)

    const big = await post('init', { invoice: peer('addinvoice', '--amt', '1000').payment_request, userPubkey: user })
    expect(big.status).toBe(200)
    expect(big.body.feeSats).toBe(5) // ceil(1,000 × 0.5%)
    // 1,005 ≥ dust → the VHTLC, with the receiver's claim maturing first (C1)
    expect(big.body.script).toBe('vhtlc')
    expect(big.body.vhtlc.refundNoReceiverDelaySecs).toBeGreaterThan(big.body.vhtlc.claimDelaySecs)
    expect((await post('init', { invoice: 'lnbcrt1garbage', userPubkey: user })).status).toBe(400)
    expect((await post('init', { invoice: inv.payment_request })).body.error).toBe('undefined parameter: userPubkey')
    expect((await fetch(`${base}/v2/subdust/atomic/send/status?swapId=nope`)).status).toBe(400)
  }, 60_000)

  test('success: pays, claims a+fee with the preimage; status serves it', async () => {
    const inv = peer('addinvoice', '--amt', '21')
    const p = await prepare(inv.payment_request)
    const fund = await post('fund', p.fundBody)
    expect(fund.status).toBe(200)
    expect(fund.body.status).toBe('claimed')
    expect(sha256(fund.body.preimage)).toBe(inv.r_hash)
    expect(fund.body.claimTxid).toMatch(/^[0-9a-f]{64}$/)
    expect(peer('lookupinvoice', inv.r_hash).state).toBe('SETTLED')
    expect(await status(p.init.swapId)).toEqual({ state: 'claimed', preimage: fund.body.preimage })
    // The funder's change came back as one regular coin.
    const back = await waitFor('the claim change', async () =>
      (await funder.ownVtxos()).find((v) => v.txid === fund.body.claimTxid),
    )
    expect(back.value).toBe(p.shared.value - 21 - 1)
  }, 120_000)

  /** A coin of exactly `value` on the funder, for dust+ sends (the float holds 2,000-sat coins). */
  const bigCoin = async (value: number) => {
    topUpFunder(value)
    sh('arkd', 'ark', 'send', '--to', (await funder.receiveAddress()).encode(), '--amount', String(value), '--password', 'secret')
    await waitFor(`a ${value}-sat coin`, async () => (await funder.ownVtxos()).find((v) => v.value === value))
  }

  // Dust+ rides the VHTLC (F32_VHTLC_PLAN): the VHTLC holds exactly a + fee,
  // the change comes back in the funding tx, and the claim needs no presig.
  test('dust+ VHTLC: pays 100,000, claims the whole a + fee alone; the change came back in the funding tx', async () => {
    await bigCoin(150_000)
    const inv = peer('addinvoice', '--amt', '100000')
    const p = await prepare(inv.payment_request, 150_000)
    expect(p.init.feeSats).toBe(500)
    expect(p.init.script).toBe('vhtlc')
    expect(p.fundBody).not.toHaveProperty('presigs')
    const fund = await post('fund', p.fundBody)
    expect(fund.body.status).toBe('claimed')
    expect(sha256(fund.body.preimage)).toBe(inv.r_hash)
    expect(peer('lookupinvoice', inv.r_hash).state).toBe('SETTLED')
    const back = await waitFor('the funding change', async () =>
      (await funder.ownVtxos()).find((v) => v.txid === p.shared.txid),
    )
    expect(back.value).toBe(150_000 - 100_000 - 500)
    const ours = await waitFor('our claim output', async () =>
      (await signer.ownVtxos()).find((v) => v.txid === fund.body.claimTxid),
    )
    expect(ours.value).toBe(100_500)
  }, 180_000)

  test('dust+ VHTLC: LN fails → failed, and the cooperative refund leaf returns the whole VHTLC', async () => {
    await bigCoin(80_000)
    const { hash } = secret()
    const bolt11 = peer('addholdinvoice', hash, '--amt', '50000').payment_request
    const p = await prepare(bolt11, 80_000)
    expect(p.init.script).toBe('vhtlc')
    const funding = post('fund', p.fundBody)
    await waitFor('the peer to hold our HTLC', () => peer('lookupinvoice', hash).state === 'ACCEPTED' || undefined)
    peer('cancelinvoice', hash)
    expect((await funding).body.status).toBe('failed')
    const c = await post('cancel', await cancelBody(p))
    expect(c.body.status).toBe('cancelled')
    const back = await waitFor('the funding back on the funder', async () =>
      (await funder.ownVtxos()).find((v) => v.txid === c.body.cancelTxid),
    )
    expect(back.value).toBe(50_250) // the VHTLC (a + fee); the other 29,750 never left — funding-tx change
  }, 180_000)

  test('dust+ VHTLC: a dropped pay stream → 503; resolve claims through the claim leaf with no presig on the row', async () => {
    await bigCoin(9_000)
    const { preimage, hash } = secret()
    const bolt11 = peer('addholdinvoice', hash, '--amt', '5000').payment_request
    const p = await prepare(bolt11, 9_000)
    expect(p.init.script).toBe('vhtlc')
    const dropping = {
      ...lnd,
      decodeInvoice: lnd.decodeInvoice.bind(lnd),
      getInfo: lnd.getInfo.bind(lnd),
      queryRoutes: lnd.queryRoutes.bind(lnd),
      trackPayment: lnd.trackPayment.bind(lnd),
      sendPayment: async (b: string, o: Parameters<LndClient['sendPayment']>[1]) => {
        void lnd.sendPayment(b, o).catch(() => {})
        await waitFor('the payment to exist in LND', async () => ((await lnd.trackPayment(hash)).found ? true : undefined))
        throw new LndError('SendPaymentV2', 14, 'stream dropped')
      },
    }
    const svc = new SendService({ store, signer, lnd: dropping, knobs, log: createLogger('error'), locks, emit: () => {} })
    expect((await svc.fund(p.fundBody).catch((e) => e)).status).toBe(503)
    expect(store.get(p.init.swapId)).toMatchObject({ state: 'ln_inflight', presigs: null })
    await waitFor('the peer to hold our HTLC', () => peer('lookupinvoice', hash).state === 'ACCEPTED' || undefined)
    peer('settleinvoice', preimage)
    const resolved = await waitFor('resolve to claim', async () => (await svc.resolveInflight(p.init.swapId)) ?? undefined)
    expect(resolved).toBe('claimed')
    const ours = await waitFor('our claim output', async () => (await signer.ownVtxos()).find((v) => v.value === 5_025))
    expect(ours.value).toBe(5_025)
  }, 180_000)

  test('LN fails terminally → failed; a cancel during the live HTLC is refused, after it the funding comes back', async () => {
    const { hash } = secret()
    const bolt11 = peer('addholdinvoice', hash, '--amt', '21').payment_request
    const p = await prepare(bolt11)
    const funding = post('fund', p.fundBody)
    await waitFor('the peer to hold our HTLC', () => peer('lookupinvoice', hash).state === 'ACCEPTED' || undefined)
    // Live HTLC: refused — by the swap lock (fund still holds it) and, behind it, the gate.
    expect((await post('cancel', await cancelBody(p))).body.status).toBe('refused')
    peer('cancelinvoice', hash)
    expect((await funding).body).toEqual({ status: 'failed', error: 'FAILURE_REASON_INCORRECT_PAYMENT_DETAILS' })
    const c = await post('cancel', await cancelBody(p))
    expect(c.body.status).toBe('cancelled')
    expect(store.get(p.init.swapId)?.state).toBe('cancelled')
    await waitFor('the funding back on the funder', async () => (await funder.ownVtxos()).find((v) => v.txid === c.body.cancelTxid))
  }, 120_000)

  test('F26: while a swap is locked, cancel is refused and resolve skips it', async () => {
    const inv = peer('addinvoice', '--amt', '21')
    const p = await prepare(inv.payment_request)
    const release = locks.tryAcquire(p.init.swapId)!
    expect((await post('cancel', await cancelBody(p))).body).toEqual({ status: 'refused', error: 'a fund or cancel for this swap is in flight' })
    expect((await post('fund', p.fundBody)).body.error).toContain('is busy')
    release()
    expect((await post('fund', p.fundBody)).body.status).toBe('claimed')
  }, 120_000)

  test('F25: a dropped pay stream after the HTLC left → 503, stays ln_inflight; resolve claims once the payee settles', async () => {
    const { preimage, hash } = secret()
    const bolt11 = peer('addholdinvoice', hash, '--amt', '21').payment_request
    const p = await prepare(bolt11)
    const dropping = {
      ...lnd,
      decodeInvoice: lnd.decodeInvoice.bind(lnd),
      getInfo: lnd.getInfo.bind(lnd),
      queryRoutes: lnd.queryRoutes.bind(lnd),
      trackPayment: lnd.trackPayment.bind(lnd),
      sendPayment: async (b: string, o: Parameters<LndClient['sendPayment']>[1]) => {
        void lnd.sendPayment(b, o).catch(() => {})
        await waitFor('the payment to exist in LND', async () => ((await lnd.trackPayment(hash)).found ? true : undefined))
        throw new LndError('SendPaymentV2', 14, 'stream dropped')
      },
    }
    const svc = new SendService({ store, signer, lnd: dropping, knobs, log: createLogger('error'), locks, emit: () => {} })
    const err = await svc.fund(p.fundBody).catch((e) => e)
    expect(err.status).toBe(503)
    expect(store.get(p.init.swapId)?.state).toBe('ln_inflight')
    await waitFor('the peer to hold our HTLC', () => peer('lookupinvoice', hash).state === 'ACCEPTED' || undefined)
    expect(await svc.resolveInflight(p.init.swapId)).toBeUndefined()
    expect(store.get(p.init.swapId)?.state).toBe('ln_inflight')
    peer('settleinvoice', preimage)
    const resolved = await waitFor('resolve to claim', async () => (await svc.resolveInflight(p.init.swapId)) ?? undefined)
    expect(resolved).toBe('claimed')
    expect(store.get(p.init.swapId)).toMatchObject({ state: 'claimed', preimage })
  }, 120_000)

  test('F25: a pay that never reached LND resolves to failed, and the funder can cancel', async () => {
    const inv = peer('addinvoice', '--amt', '21')
    const p = await prepare(inv.payment_request)
    const neverSent = { ...lnd, decodeInvoice: lnd.decodeInvoice.bind(lnd), getInfo: lnd.getInfo.bind(lnd), queryRoutes: lnd.queryRoutes.bind(lnd), trackPayment: lnd.trackPayment.bind(lnd), sendPayment: async () => { throw new LndError('SendPaymentV2', 14, 'unavailable') } }
    const svc = new SendService({ store, signer, lnd: neverSent, knobs, log: createLogger('error'), locks, emit: () => {} })
    expect((await svc.fund(p.fundBody).catch((e) => e)).status).toBe(503)
    expect(await svc.resolveInflight(p.init.swapId)).toBe('failed')
    expect((await post('cancel', await cancelBody(p))).body.status).toBe('cancelled')
  }, 120_000)

  test('past the pay margin it never pays: refund_wait, and the funder may cancel', async () => {
    const inv = peer('addinvoice', '--amt', '21')
    const p = await prepare(inv.payment_request)
    const late = new SendService({ store, signer, lnd, knobs: { ...knobs, payMarginSecs: 1_000_000 }, log: createLogger('error'), locks, emit: () => {} })
    const err = await late.fund(p.fundBody).catch((e) => e)
    expect(err.message).toContain('too close to T')
    expect(store.get(p.init.swapId)?.state).toBe('refund_wait')
    expect(peer('lookupinvoice', inv.r_hash).state).toBe('OPEN')
    expect((await post('cancel', await cancelBody(p))).body.status).toBe('cancelled')
  }, 120_000)

  test('a claimed send cannot be cancelled', async () => {
    const claimed = store.list('send', ['claimed'])[0]!
    const res = await post('cancel', { swapId: claimed.id, fundingOutpoint: claimed.fundingOutpoint, outputs: [{ script: '00', amount: 1 }], presigs: {} })
    expect(res.body).toEqual({ status: 'claimed', error: 'swap is claimed — not cancellable' })
  })
})
