import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
import { OnchainWallet, SingleKey, Unroll, timelockToSequence } from '@arkade-os/sdk'
import { buildVhtlc, roleLeaves, signLeafSpendAtRate } from '../../src/atomic/index.ts'
import { BitcoindOnchainProvider, BitcoindRpc } from '../../src/chain/bitcoind'
import { ReceiveService } from '../../subdustd/api/receive.ts'
import { SwapLocks } from '../../subdustd/api/http_error.ts'
import { ArkSigner } from '../../subdustd/ark/signer.ts'
import type { SubdustKnobs } from '../../subdustd/config.ts'
import { LndClient } from '../../subdustd/lnd/client.ts'
import { createLogger } from '../../subdustd/log.ts'
import { OnchainExecutor } from '../../subdustd/onchain.ts'
import { SwapStore } from '../../subdustd/store.ts'

// The receive side of the executor (F32_VHTLC_PLAN §5.4), with subdustd as the
// VHTLC's sender. The user (played here) unrolls the VHTLC:
//   A. and claims it on chain with the preimage (what the bridge does when its
//      offchain claim is censored, R1/R5) → subdustd reads the preimage out of
//      that claim and settles the payer's HTLC — it gets paid for what it gave;
//   B. and never claims (griefing) → after d_s subdustd takes the VHTLC back
//      through its own leaf and, once that refund confirms, cancels the HTLC.
//
// Moves the regtest clock (setmocktime, relative to MTP): run it alone or last.
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/vhtlc_executor_receive.test.ts

const ARKD_URL = process.env.SUBDUSTD_ARKD_URL
const CERT = process.env.SUBDUSTD_LND_CERT
const MACAROON = process.env.SUBDUSTD_LND_MACAROON
const SOCKET = process.env.SUBDUSTD_LND_SOCKET ?? '127.0.0.1:10009'
const BITCOIND = process.env.REGTEST_BITCOIND_URL ?? 'http://localhost:18443'

const sh = (container: string, ...args: string[]) =>
  execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const peer = (...args: string[]): any => JSON.parse(sh('lnd-peer', 'lncli', '--network=regtest', ...args))
const sha256 = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 240_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const payers: ChildProcess[] = []
const peerPays = (bolt11: string) => {
  payers.push(spawn('docker', ['exec', 'lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', bolt11], { stdio: 'ignore' }))
}
const peerPaymentStatus = (hash: string): string | undefined =>
  peer('listpayments', '--include_incomplete', '--max_payments', '300').payments.find((p: any) => p.payment_hash === hash)?.status
const knobs: SubdustKnobs = { sendWindowSecs: 3_600, receiveWindowSecs: 600, payMarginSecs: 60, blockTimeSecs: 30, sendFeePercent: 0.5 }

describe.skipIf(!ARKD_URL || !CERT || !MACAROON)('the executor on a receive: the user unrolls the VHTLC', () => {
  const rpc = new BitcoindRpc({ url: BITCOIND, user: 'admin1', password: '123' })
  const wallet = new BitcoindRpc({ url: `${BITCOIND}/wallet/default`, user: 'admin1', password: '123' })
  const chain = new BitcoindOnchainProvider(rpc)
  let store: SwapStore
  let lnd: LndClient
  let signer: ArkSigner
  let service: ReceiveService
  let executor: OnchainExecutor
  let miner: string
  let ticking: ReturnType<typeof setInterval> | undefined
  const mine = async (n: number) => void (await rpc.call('generatetoaddress', [n, miner]))
  const jumpPast = async (secs: number) => {
    const mtp = (await rpc.call<{ mediantime: number }>('getblockchaininfo')).mediantime
    await rpc.call('setmocktime', [Math.max(mtp, Math.floor(Date.now() / 1000)) + secs + 300])
    await mine(12)
  }

  beforeAll(async () => {
    store = SwapStore.open(join(mkdtempSync(join(tmpdir(), 'vhtlc-exec-recv-')), 'swaps.sqlite'))
    lnd = new LndClient({ socket: SOCKET, certPath: CERT!, macaroonPath: MACAROON! })
    signer = new ArkSigner(randomBytes(32), ARKD_URL!)
    const locks = new SwapLocks()
    const log = createLogger('info')
    service = new ReceiveService({ store, signer, lnd, knobs, log, locks, emit: () => {} })
    executor = new OnchainExecutor({ store, signer, provider: chain, network: 'regtest', lnd, receive: service, locks, log, emit: () => {}, pollMs: 1_000 })
    miner = await wallet.call<string>('getnewaddress', [])
    await wallet.call('sendtoaddress', [(await executor.fuel()).address, 0.001])
    // subdustd's float: two 20,000-sat coins, one per scenario
    const addr = (await signer.receiveAddress()).encode()
    for (let i = 0; i < 2; i++) {
      const note = sh('arkd', 'arkd', 'note', '--amount', '21000')
      sh('arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
      sh('arkd', 'ark', 'send', '--to', addr, '--amount', '20000', '--password', 'secret')
    }
    await waitFor('the float', async () => ((await signer.ownVtxos()).length >= 2 ? true : undefined))
    ticking = setInterval(() => void mine(1).catch(() => {}), 2_000)
  }, 240_000)

  afterAll(async () => {
    if (ticking) clearInterval(ticking)
    executor?.stop()
    for (const p of payers) p.kill()
    service?.close()
    await rpc.call('setmocktime', [0]).catch(() => {})
    lnd?.close()
    store?.close()
  })

  /** A funded VHTLC receive, and the user's own unroll of it. */
  const fundedAndUnrolled = async () => {
    const preimage = randomBytes(32).toString('hex')
    const hash = sha256(preimage)
    const user = SingleKey.fromPrivateKey(randomBytes(32))
    const init = await service.init({ amount: 5_000, paymentHash: hash, userPubkey: hex.encode(await user.xOnlyPublicKey()) })
    expect(init.script).toBe('vhtlc')
    peerPays(init.invoice)
    const row = await waitFor('funded', () => {
      const r = store.get(init.swapId)
      return r?.state === 'funded' ? r : undefined
    })
    const [txid, vout] = row.fundingOutpoint!.split(':')
    const userFuel = await OnchainWallet.create(user, 'regtest', chain)
    await wallet.call('sendtoaddress', [userFuel.address, 0.002])
    await waitFor('the user’s fuel confirmed', async () => ((await chain.getCoins(userFuel.address)).length > 0 ? true : undefined))
    const session = await Unroll.Session.create({ txid: txid!, vout: Number(vout) }, userFuel, chain, signer.indexer)
    for await (const _ of session) {
      /* to DONE */
    }
    await waitFor('the executor at csv_wait', async () => {
      await executor.scan()
      return store.get(init.swapId)?.onchain?.stage === 'csv_wait' ? true : undefined
    })
    const script = buildVhtlc({
      sender: await signer.xOnlyPublicKey(),
      receiver: await user.xOnlyPublicKey(),
      server: await signer.serverXOnly(),
      paymentHash: hex.decode(hash),
      timeouts: { refundLocktime: row.refundLocktime, ...row.vhtlc! },
    })
    return { init, row, preimage, hash, user, userFuel, outpoint: { txid: txid!, vout: Number(vout) }, script }
  }

  test('A: the user claims on chain → subdustd settles the payer’s HTLC from the preimage in that claim', async () => {
    const s = await fundedAndUnrolled()
    await jumpPast(s.row.vhtlc!.claimDelaySecs)
    const claim = await signLeafSpendAtRate(
      {
        ...s.outpoint,
        value: 5_000,
        pkScript: s.script.pkScript,
        leaf: roleLeaves(s.script).uclaim!,
        sequence: timelockToSequence({ type: 'seconds', value: BigInt(s.row.vhtlc!.claimDelaySecs) }),
        preimage: hex.decode(s.preimage),
        destination: s.userFuel.onchainP2TR.script,
      },
      2,
      s.user,
    )
    await chain.broadcastTransaction(claim.hex)
    await waitFor('settled', () => (store.get(s.init.swapId)?.state === 'settled' ? true : undefined))
    expect(store.get(s.init.swapId)).toMatchObject({ preimage: s.preimage })
    await waitFor('the payer to see SUCCEEDED', () => (peerPaymentStatus(s.hash) === 'SUCCEEDED' ? true : undefined))
  }, 600_000)

  test('B: the user unrolls and never claims → after d_s subdustd refunds on chain, then releases the payer', async () => {
    const s = await fundedAndUnrolled()
    await jumpPast(s.row.vhtlc!.refundNoReceiverDelaySecs)
    await waitFor('refunded', () => (store.get(s.init.swapId)?.state === 'refunded' ? true : undefined))
    const row = store.get(s.init.swapId)!
    expect(row.onchain?.stage).toBe('done')
    expect((await chain.getTxStatus(row.onchain!.spendTxid!)).confirmed).toBe(true)
    await waitFor('the payer refunded', () => (peerPaymentStatus(s.hash) === 'FAILED' ? true : undefined))
  }, 600_000)
})
