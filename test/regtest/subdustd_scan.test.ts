import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
import { DefaultVtxo, SingleKey } from '@arkade-os/sdk'
import { AtomicVtxoScript, computeClaimSplit, finishClaim, type SharedVtxo } from '../../src/atomic/index.ts'
import { ReceiveService } from '../../subdustd/api/receive.ts'
import { SwapLocks } from '../../subdustd/api/http_error.ts'
import { ArkSigner, hrpOf } from '../../subdustd/ark/signer.ts'
import type { SubdustKnobs } from '../../subdustd/config.ts'
import { LndClient } from '../../subdustd/lnd/client.ts'
import { createLogger } from '../../subdustd/log.ts'
import { Scanner } from '../../subdustd/scanner.ts'
import { SwapStore } from '../../subdustd/store.ts'

// The scanner — the durable half of the receive path — against real regtest:
// it settles from a harvested preimage when the receiver never calls settle
// (F1), refuses to refund before chain MTP passes T, refunds after it (F2), and
// finishes a refund whose hold-invoice cancel blipped (F16).
//
//   SUBDUSTD_ARKD_URL=http://localhost:7070 SUBDUSTD_LND_CERT=… SUBDUSTD_LND_MACAROON=… \
//     bun test test/regtest/subdustd_scan.test.ts
//
// Mines 12 regtest blocks (to move MTP past T).

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
const mine = (n: number) =>
  sh('bitcoin', 'bitcoin-cli', '-regtest', '-rpcuser=admin1', '-rpcpassword=123', 'generatetoaddress', String(n), peer('newaddress', 'p2wkh').address)
const sha256 = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 90_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(500)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const payers: ChildProcess[] = []
const peerPays = (bolt11: string) => {
  payers.push(spawn('docker', ['exec', PEER, 'lncli', '--network=regtest', 'payinvoice', '--force', bolt11], { stdio: 'ignore' }))
}
const peerPaymentStatus = (hash: string): string | undefined =>
  peer('listpayments', '--include_incomplete', '--max_payments', '300').payments.find((p: any) => p.payment_hash === hash)?.status

// A 30s receive window so T passes inside the test; 2s blocks keep the hold
// invoice's final CLTV (⌈30/2⌉ + 18 = 33) well clear of the 12 blocks mined.
const knobs: SubdustKnobs = { sendWindowSecs: 3_600, receiveWindowSecs: 30, payMarginSecs: 60, blockTimeSecs: 2, sendFeePercent: 0.5 }

describe.skipIf(!ARKD_URL || !CERT || !MACAROON)('subdustd scanner on regtest', () => {
  let store: SwapStore
  let lnd: LndClient
  let signer: ArkSigner
  let locks: SwapLocks
  let receive: ReceiveService
  const log = createLogger('error')
  const scannerWith = (r: ReceiveService) =>
    new Scanner({ store, send: { resolveInflight: async () => undefined }, receive: r, medianTimePast: () => lnd.medianTimePast(), log })

  const fundedReceive = async (svc: ReceiveService) => {
    const preimage = randomBytes(32).toString('hex')
    const r = { user: SingleKey.fromPrivateKey(randomBytes(32)), preimage, hash: sha256(preimage) }
    const init = await svc.init({ amount: 21, paymentHash: r.hash, userPubkey: hex.encode(await r.user.xOnlyPublicKey()) })
    peerPays(init.invoice)
    await waitFor('funded', () => (store.get(init.swapId)?.state === 'funded' ? true : undefined))
    return { ...r, swapId: init.swapId }
  }

  beforeAll(async () => {
    store = SwapStore.open(join(mkdtempSync(join(tmpdir(), 'subdustd-scan-')), 'swaps.sqlite'))
    lnd = new LndClient({ socket: SOCKET, certPath: CERT!, macaroonPath: MACAROON! })
    signer = new ArkSigner(randomBytes(32), ARKD_URL!)
    locks = new SwapLocks()
    receive = new ReceiveService({ store, signer, lnd, knobs, log, locks, emit: () => {} })
    const addr = (await signer.receiveAddress()).encode()
    for (let i = 0; i < 3; i++) {
      const note = sh('arkd', 'arkd', 'note', '--amount', '2000')
      sh('arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
      sh('arkd', 'ark', 'send', '--to', addr, '--amount', '1000', '--password', 'secret')
    }
    await waitFor('the float', async () => ((await signer.ownVtxos()).length >= 3 ? true : undefined))
  }, 240_000)

  afterAll(() => {
    for (const p of payers) p.kill()
    receive?.close()
    lnd?.close()
    store?.close()
  })

  test('F1: the receiver claims but never calls settle — the scan harvests the preimage and settles', async () => {
    const r = await fundedReceive(receive)
    const swap = store.get(r.swapId)!
    const info = await signer.getInfo()
    const server = await signer.serverXOnly()
    const d = swap.selfDelay!
    const t = { type: d >= 512n ? ('seconds' as const) : ('blocks' as const), value: d }
    const script = new AtomicVtxoScript({
      funder: await signer.xOnlyPublicKey(),
      claimer: await r.user.xOnlyPublicKey(),
      server,
      paymentHash: hex.decode(r.hash),
      refundLocktime: BigInt(swap.refundLocktime),
      exitDelay: d,
    })
    const [txid, vout] = swap.fundingOutpoint!.split(':')
    const shared: SharedVtxo = { txid: txid!, vout: Number(vout), value: swap.fundingValue!, script }
    const split = computeClaimSplit({
      funderAddress: await signer.receiveAddress(d),
      claimerAddress: new DefaultVtxo.Script({ pubKey: await r.user.xOnlyPublicKey(), serverPubKey: server, csvTimelock: t }).address(hrpOf(info), server),
      fundingValue: shared.value,
      amount: 21,
      dust: Number(info.dust),
    })
    await finishClaim(shared, split.outputs, await signer.serverUnroll(), JSON.parse(swap.presigs!), r.user, hex.decode(r.preimage), signer.ark)

    expect(await scannerWith(receive).pass()).toBe(true)
    expect(store.get(r.swapId)).toMatchObject({ state: 'settled', preimage: r.preimage })
    await waitFor('the payer to see SUCCEEDED', () => peerPaymentStatus(r.hash) === 'SUCCEEDED' || undefined)
  }, 180_000)

  test('F2 + F16: no refund while MTP < T; after MTP passes, refund lands, a blipped cancel is retried, payer refunded', async () => {
    const floatTotal = async () => (await signer.ownVtxos()).reduce((n, v) => n + v.value, 0)
    const before = await floatTotal()
    const r = await fundedReceive(receive)
    const swap = store.get(r.swapId)!
    await waitFor('wall clock past T', () => (Date.now() / 1000 > swap.refundLocktime + 2 ? true : undefined))
    // Wall clock is past T, the chain clock is not: refunding now would be rejected and poison the txid.
    expect(await lnd.medianTimePast()).toBeLessThan(swap.refundLocktime)
    await scannerWith(receive).pass()
    expect(store.get(r.swapId)?.state).toBe('funded')

    mine(12)
    await waitFor('MTP past T', async () => ((await lnd.medianTimePast()) > swap.refundLocktime ? true : undefined))
    let blips = 0
    const blipping = new ReceiveService({
      store,
      signer,
      lnd: {
        addHoldInvoice: lnd.addHoldInvoice.bind(lnd),
        lookupInvoice: lnd.lookupInvoice.bind(lnd),
        settleHoldInvoice: lnd.settleHoldInvoice.bind(lnd),
        subscribeSingleInvoice: lnd.subscribeSingleInvoice.bind(lnd),
        cancelHoldInvoice: async () => {
          blips++
          throw new Error('lnd blip')
        },
      },
      knobs,
      log,
      locks,
      emit: () => {},
    })
    await scannerWith(blipping).pass()
    // The same pass reaches refund_wait right after the refund and retries once more — both blip.
    expect(blips).toBe(2)
    expect(store.get(r.swapId)?.state).toBe('refund_wait')
    // The refund is ours on-chain: the float is whole again (less a sub-dust
    // remainder only if a poisoned txid forced a split re-mint).
    expect(await floatTotal()).toBeGreaterThanOrEqual(before - 20)

    await scannerWith(receive).pass()
    expect(store.get(r.swapId)?.state).toBe('refunded')
    await waitFor('the payer refunded', () => peerPaymentStatus(r.hash) === 'FAILED' || undefined)
    blipping.close()
  }, 240_000)

  test('a real restart: the payer pays while subdustd is down, and the boot pass funds the held invoice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subdustd-restart-'))
    const key = randomBytes(32)
    writeFileSync(join(dir, 'key'), `${hex.encode(key)}\n`, { mode: 0o600 })
    const own = new ArkSigner(key, ARKD_URL!)
    const note = sh('arkd', 'arkd', 'note', '--amount', '2000')
    sh('arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
    sh('arkd', 'ark', 'send', '--to', (await own.receiveAddress()).encode(), '--amount', '1000', '--password', 'secret')
    await waitFor('its float', async () => ((await own.ownVtxos()).length > 0 ? true : undefined))
    const port = (() => {
      const s = Bun.serve({ port: 0, fetch: () => new Response() })
      const p = s.port
      s.stop(true)
      return p
    })()
    const config = join(dir, 'c.json')
    writeFileSync(
      config,
      JSON.stringify({
        network: 'regtest',
        arkdUrl: ARKD_URL,
        lnd: { socket: SOCKET, certPath: CERT, macaroonPath: MACAROON },
        keyPath: join(dir, 'key'),
        dbPath: join(dir, 'swaps.sqlite'),
        http: { port },
        logLevel: 'error',
        subdust: { ...knobs, receiveWindowSecs: 600 },
      }),
    )
    const base = `http://127.0.0.1:${port}/v2/subdust/atomic/receive`
    const boot = async () => {
      const child = Bun.spawn(['bun', 'run', 'subdustd/main.ts', config], { stdout: 'ignore', stderr: 'ignore' })
      await waitFor('subdustd up', async () => ((await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.ok ? true : undefined))
      return child
    }

    let child = await boot()
    const preimage = randomBytes(32).toString('hex')
    const user = SingleKey.fromPrivateKey(randomBytes(32))
    const init = (await (
      await fetch(`${base}/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: 21, paymentHash: sha256(preimage), userPubkey: hex.encode(await user.xOnlyPublicKey()) }),
      })
    ).json()) as { swapId: string; invoice: string }
    child.kill('SIGTERM')
    expect(await child.exited).toBe(0)

    peerPays(init.invoice)
    await waitFor('the HTLC held while we are down', async () => ((await lnd.lookupInvoice(sha256(preimage))).state === 'ACCEPTED' ? true : undefined))

    child = await boot()
    const st = await waitFor('the boot pass to fund it', async () => {
      const s = (await (await fetch(`${base}/status?swapId=${init.swapId}`)).json()) as { state: string }
      return s.state === 'funded' ? s : undefined
    })
    expect(st.state).toBe('funded')
    child.kill('SIGTERM')
    await child.exited
    await lnd.cancelHoldInvoice(sha256(preimage)) // leave the payer whole
  }, 240_000)
})
