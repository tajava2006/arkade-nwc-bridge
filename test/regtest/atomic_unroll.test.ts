import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { hex } from '@scure/base'
import { Address, OutScript } from '@scure/btc-signer'
import {
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  OnchainWallet,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  timelockToSequence,
  Unroll,
  Wallet,
} from '@arkade-os/sdk'
import { AtomicVtxoScript, buildUexitSweep } from '../../src/atomic/index.ts'

// The funder's ASP-free escape from a stalled atomic sub-dust swap, on SDK 0.5
// (ported from spike #02, SM-34): fund the shared 4-leaf vtxo offchain, unroll
// it onchain with Unroll.Session (CPFP from the funder's onchain wallet), wait
// the CSV, and sweep the FULL value through the uexit leaf. This is what makes
// an in-flight swap's shared vtxo safe to hold in the exit vault.
//
// BLOCK mode (CSV in blocks, elapsed by mining) — e.g. the stack boost-drill.sh
// leaves up:
//   REGTEST_ARKD_URL=http://localhost:7070 REGTEST_DIR=<arkade-regtest> \
//     bun test test/regtest/atomic_unroll.test.ts

const ARKD = process.env.REGTEST_ARKD_URL
const REGTEST_DIR = process.env.REGTEST_DIR
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'
const V = 10_000

const regtest = (...args: string[]) => execFileSync('node', [`${REGTEST_DIR}/regtest.mjs`, ...args], { encoding: 'utf8', cwd: REGTEST_DIR })
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined) return v
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}

describe.skipIf(!ARKD || !REGTEST_DIR)('atomic shared vtxo: funder unilateral exit via uexit (SDK 0.5)', () => {
  const esplora = new EsploraProvider(ESPLORA, { forcePolling: true, pollingInterval: 2000 })
  const indexer = new RestIndexerProvider(ARKD!)
  const identity = SingleKey.fromPrivateKey(randomBytes(32))
  const claimer = SingleKey.fromPrivateKey(randomBytes(32))
  let wallet: Wallet
  let fuel: OnchainWallet
  let script: AtomicVtxoScript
  let shared: { txid: string; vout: number }
  let delay: bigint

  beforeAll(async () => {
    wallet = await Wallet.create({
      identity,
      operatorProvider: new RestOperatorProvider(ARKD!),
      indexerProvider: indexer,
      onchainProvider: esplora,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    const info = await new RestOperatorProvider(ARKD!).getInfo()
    delay = info.unilateralExitDelay
    regtest('ark', 'send', '--to', await wallet.getAddress(), '--amount', String(V + 5_000), '--password', 'secret')
    await waitFor('the funder float', async () => ((await wallet.getBalance()).available >= V ? true : undefined))
    fuel = await OnchainWallet.create(identity, 'regtest', esplora)
    regtest('faucet', fuel.address, '0.01')
    regtest('mine', '1')
    await waitFor('fuel', async () => ((await fuel.getBalance()) >= 500_000 ? true : undefined))

    const server = hex.decode(info.signerPubkey).subarray(1)
    script = new AtomicVtxoScript({
      funder: (await identity.xOnlyPublicKey()).subarray(-32),
      claimer: (await claimer.xOnlyPublicKey()).subarray(-32),
      server,
      paymentHash: randomBytes(32),
      refundLocktime: BigInt(Math.floor(Date.now() / 1000) + 3600),
      exitDelay: delay,
    })
    await wallet.send({ address: script.address('tark', server).encode(), amount: V })
    regtest('mine', '1')
    shared = await waitFor('the shared vtxo', async () => {
      const { vtxos } = await indexer.getVtxos({ scripts: [hex.encode(script.pkScript)], spendableOnly: true })
      const v = vtxos.find((x) => x.value === V)
      return v ? { txid: v.txid, vout: v.vout } : undefined
    })
  }, 600_000)

  afterAll(async () => {
    await wallet?.dispose()
  })

  test('arkd runs block-denominated CSV here (the test elapses it by mining)', () => {
    expect(delay).toBeLessThan(512n)
  })

  test('Unroll.Session drives the shared vtxo onchain', async () => {
    const session = await Unroll.Session.create(shared, fuel, esplora, indexer)
    let done = false
    for (let i = 0; i < 60 && !done; i++) {
      const step = await session.next()
      if (step.type === Unroll.StepType.DONE) done = true
      else {
        regtest('mine', '1')
        await Bun.sleep(1200)
      }
    }
    expect(done).toBe(true)
    const conf = await waitFor('the shared output confirmed', async () => {
      const st = await esplora.getTxStatus(shared.txid)
      if (st.confirmed) return st
      regtest('mine', '1')
      return undefined
    })
    expect(conf.confirmed).toBe(true)
  }, 600_000)

  test('after the CSV, the funder sweeps the FULL value through the uexit leaf', async () => {
    regtest('mine', String(Number(delay) + 2))
    const fee = 1_000
    const sweep = buildUexitSweep({
      txid: shared.txid,
      vout: shared.vout,
      value: V,
      script,
      sequence: timelockToSequence({ type: 'blocks', value: delay }),
      outputScript: OutScript.encode(Address(fuel.network).decode(fuel.address)),
      feeSats: fee,
    })
    const signed = await identity.sign(sweep)
    signed.finalize()
    const before = await fuel.getBalance()
    await esplora.broadcastTransaction(signed.hex)
    await waitFor('the sweep confirmed', async () => {
      regtest('mine', '1')
      return (await esplora.getTxStatus(signed.id)).confirmed ? true : undefined
    })
    const after = await waitFor('the fuel wallet to see it', async () => {
      const b = await fuel.getBalance()
      return b > before ? b : undefined
    })
    expect(after - before).toBe(V - fee)
  }, 300_000)

  test('the claimer is on no unilateral path — uexit is funder-only', async () => {
    const uexit = hex.encode(script.uexit()[1])
    expect(uexit).toContain(hex.encode((await identity.xOnlyPublicKey()).subarray(-32)))
    expect(uexit).not.toContain(hex.encode((await claimer.xOnlyPublicKey()).subarray(-32)))
  })
})
