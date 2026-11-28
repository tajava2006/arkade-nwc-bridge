import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
import { OnchainWallet, Unroll, timelockToSequence, type ArkTxInput } from '@arkade-os/sdk'
import { buildVhtlc, fundShared, roleLeaves, signLeafSpend, type SharedVtxo } from '../../src/atomic/index.ts'
import { BitcoindOnchainProvider, BitcoindRpc } from '../../src/chain/bitcoind'
import { SendService } from '../../subdustd/api/send.ts'
import { SwapLocks } from '../../subdustd/api/http_error.ts'
import { ArkSigner } from '../../subdustd/ark/signer.ts'
import type { SubdustKnobs } from '../../subdustd/config.ts'
import { LndClient } from '../../subdustd/lnd/client.ts'
import { createLogger } from '../../subdustd/log.ts'
import { OnchainExecutor } from '../../subdustd/onchain.ts'
import { SwapStore } from '../../subdustd/store.ts'

/**
 * Hand the clock back after a jump. setmocktime 0 only works while the chain's
 * MTP is within bitcoind's 2-hour future limit of the wall clock; past it every
 * new block is time-too-new and mining stops for whatever runs next. So the
 * mock time stays just past MTP until the wall catches up.
 */
const releaseClock = async (rpc: { call<T>(m: string, p?: unknown[]): Promise<T> }) => {
  const mtp = (await rpc.call<{ mediantime: number }>('getblockchaininfo')).mediantime
  const now = Math.floor(Date.now() / 1000)
  await rpc.call('setmocktime', [mtp < now + 3_600 ? 0 : mtp + 1])
}


// S1 (F32_VHTLC_PLAN §5.3) as an attack, end to end: a funder funds a dust+
// send's VHTLC, makes subdustd pay its own hold invoice, unrolls the VHTLC
// while holding the HTLC, then settles — the preimage reaches subdustd, but
// arkd won't co-sign a claim of an unrolled vtxo. The on-chain executor takes
// over and claims through unilateralClaim once d_c has passed, before the
// funder's own leaf (d_s) opens. On the 4-leaf script this funder kept both.
//
// Moves the regtest clock ~40 min (setmocktime): run it alone or last.
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/vhtlc_executor_send.test.ts

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
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 180_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const knobs: SubdustKnobs = { sendWindowSecs: 3_600, receiveWindowSecs: 60, payMarginSecs: 60, blockTimeSecs: 30, sendFeePercent: 0.5 }

describe.skipIf(!ARKD_URL || !CERT || !MACAROON)('S1 on regtest: the funder unrolls the VHTLC mid-payment; subdustd claims on chain', () => {
  const rpc = new BitcoindRpc({ url: BITCOIND, user: 'admin1', password: '123' })
  const wallet = new BitcoindRpc({ url: `${BITCOIND}/wallet/default`, user: 'admin1', password: '123' })
  const chain = new BitcoindOnchainProvider(rpc)
  let store: SwapStore
  let lnd: LndClient
  let signer: ArkSigner
  let funder: ArkSigner
  let service: SendService
  let executor: OnchainExecutor
  let miner: string
  let ticking: ReturnType<typeof setInterval> | undefined
  const mine = async (n: number) => void (await rpc.call('generatetoaddress', [n, miner]))
  const fundOnchain = async (address: string, sats: number) => {
    await wallet.call('sendtoaddress', [address, sats / 1e8])
    await mine(1)
  }

  beforeAll(async () => {
    store = SwapStore.open(join(mkdtempSync(join(tmpdir(), 'vhtlc-exec-')), 'swaps.sqlite'))
    lnd = new LndClient({ socket: SOCKET, certPath: CERT!, macaroonPath: MACAROON! })
    signer = new ArkSigner(randomBytes(32), ARKD_URL!)
    funder = new ArkSigner(randomBytes(32), ARKD_URL!)
    const locks = new SwapLocks()
    const log = createLogger('info')
    service = new SendService({ store, signer, lnd, knobs, log, locks, emit: () => {} })
    executor = new OnchainExecutor({
      store,
      signer,
      provider: chain,
      network: 'regtest',
      lnd,
      receive: { settleWith: async () => {}, resumeRefundWait: async () => {} },
      locks,
      log,
      emit: () => {},
      pollMs: 1_000,
    })
    miner = await wallet.call<string>('getnewaddress', [])
    // subdustd's fuel pays nothing here (the funder pushes the unroll), but the claim lands on it.
    await fundOnchain((await executor.fuel()).address, 100_000)
    // the funder's coin: 20,000 sats on Ark
    const note = sh('arkd', 'arkd', 'note', '--amount', '21000')
    sh('arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
    sh('arkd', 'ark', 'send', '--to', (await funder.receiveAddress()).encode(), '--amount', '20000', '--password', 'secret')
    await waitFor('the funder’s coin', async () => (await funder.ownVtxos()).find((v) => v.value === 20_000))
  }, 240_000)

  afterAll(async () => {
    if (ticking) clearInterval(ticking)
    executor?.stop()
    await releaseClock(rpc).catch(() => {})
    lnd?.close()
    store?.close()
  })

  test('paid, unrolled, settled late → claimed on chain before the funder’s leaf opens', async () => {
    const preimage = randomBytes(32).toString('hex')
    const hash = sha256(preimage)
    const bolt11 = peer('addholdinvoice', hash, '--amt', '5000').payment_request

    // the funder's half: init → fund exactly a + fee into the VHTLC
    const init = await service.init({ invoice: bolt11, userPubkey: hex.encode(await funder.xOnlyPublicKey()) })
    expect(init.script).toBe('vhtlc')
    const script = buildVhtlc({
      sender: await funder.xOnlyPublicKey(),
      receiver: hex.decode(init.boltzPubkey),
      server: await funder.serverXOnly(),
      paymentHash: hex.decode(hash),
      timeouts: { refundLocktime: init.refundLocktime, ...init.vhtlc! },
    })
    const V = 5_000 + init.feeSats
    const coin = (await funder.ownVtxos()).find((v) => v.value === 20_000)!
    const self = await funder.selfScript()
    const inputs: ArkTxInput[] = [{ txid: coin.txid, vout: coin.vout, value: coin.value, tapLeafScript: self.forfeit(), tapTree: self.encode() }]
    const op = await fundShared(
      inputs,
      [
        { script: script.pkScript, amount: BigInt(V) },
        { script: (await funder.receiveAddress()).pkScript, amount: BigInt(20_000 - V) },
      ],
      await funder.serverUnroll(),
      funder.identity,
      funder.ark,
    )
    const shared: SharedVtxo = { txid: op.txid, vout: op.vout, value: V, script }

    // subdustd pays; the payee (the funder's accomplice) holds the HTLC
    const paying = service.fund({ swapId: init.swapId, fundingOutpoint: `${op.txid}:${op.vout}` }).catch((e) => e)
    await waitFor('the HTLC held', () => (peer('lookupinvoice', hash).state === 'ACCEPTED' ? true : undefined))

    // the attack: unroll the VHTLC while the HTLC is held (the funder pays the CPFPs).
    // Unroll.Session waits for each confirmation before yielding the step, and
    // this regtest doesn't mine on its own — so blocks tick in the background.
    const funderFuel = await OnchainWallet.create(funder.identity, 'regtest', chain)
    await fundOnchain(funderFuel.address, 200_000)
    ticking = setInterval(() => void mine(1).catch(() => {}), 2_000)
    const session = await Unroll.Session.create({ txid: op.txid, vout: op.vout }, funderFuel, chain, funder.indexer)
    for await (const _step of session) {
      /* drive to DONE */
    }
    expect((await chain.getTxStatus(op.txid)).confirmed).toBe(true)

    // then settle: subdustd learns the preimage, but its offchain claim is refused (unrolled)
    peer('settleinvoice', preimage)
    const fundResult = await paying
    expect(fundResult?.status).toBe(502) // "paid, claim pending"
    expect(store.get(init.swapId)?.state).toBe('ln_inflight')

    // the executor takes over: csv_wait…
    // (arkd marks the vtxo unrolled once it sees the chain; the scan repeats until it does)
    await waitFor('the executor at csv_wait', async () => {
      await executor.scan()
      return store.get(init.swapId)?.onchain?.stage === 'csv_wait' ? true : undefined
    })

    // …d_c passes (d_s hasn't): the funder's own leaf is not yet final, ours is
    const dS = init.vhtlc!.refundNoReceiverDelaySecs
    const dC = init.vhtlc!.claimDelaySecs
    expect(dS).toBeGreaterThan(dC)
    // relative to the chain's own clock (MTP), which an earlier jump may have left ahead of the wall
    const mtp = (await rpc.call<{ mediantime: number }>('getblockchaininfo')).mediantime
    await rpc.call('setmocktime', [Math.max(mtp, Math.floor(Date.now() / 1000)) + dC + 300])
    await mine(12) // the ticker keeps going; MTP settles at the mock time
    const theft = await signLeafSpend(
      {
        txid: op.txid,
        vout: op.vout,
        value: V,
        pkScript: script.pkScript,
        leaf: roleLeaves(script).uexit,
        sequence: timelockToSequence({ type: 'seconds', value: BigInt(dS) }),
        destination: funderFuel.onchainP2TR.script,
        feeSats: 500,
      },
      funder.identity,
    )
    const tried = (await rpc.call<{ allowed: boolean; 'reject-reason'?: string }[]>('testmempoolaccept', [[theft.hex]]))[0]!
    expect(tried['reject-reason']).toBe('non-BIP68-final')

    await waitFor('claimed', () => (store.get(init.swapId)?.state === 'claimed' ? true : undefined))
    const row = store.get(init.swapId)!
    expect(row.preimage).toBe(preimage)
    expect(row.onchain?.stage).toBe('done')
    const fuelCoins = await chain.getCoins((await executor.fuel()).address)
    expect(fuelCoins.some((c) => c.txid === row.onchain!.spendTxid && c.value > V - 2_000)).toBe(true)
    void shared
  }, 600_000)
})
