import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  OnchainWallet,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Unroll,
  Wallet,
} from '@arkade-os/sdk'

// F24 re-check on SDK 0.5 (SM-33): a vtxo that left through a unilateral exit
// (`isUnrolled`, not spent — arkd never marks it spent) must stay out of the
// balance, the coin lists, coin selection and consolidate-all. In 0.4.62 it
// resurrected everywhere and one such input got the whole consolidate-all
// intent rejected (VTXO_ALREADY_UNROLLED). This runs a STOCK SDK wallet — no
// bridge filter — through a real unroll.
//
//   REGTEST_ARKD_URL=http://localhost:7070 REGTEST_DIR=<arkade-regtest> \
//     bun test test/regtest/sdk05_unrolled.test.ts

const ARKD = process.env.REGTEST_ARKD_URL
const REGTEST_DIR = process.env.REGTEST_DIR
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'
const A = 20_000 // unrolled
const B = 30_000 // stays offchain

const ark = (...args: string[]) =>
  execFileSync('docker', ['exec', 'arkd', ...args], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
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

describe.skipIf(!ARKD || !REGTEST_DIR)('SDK 0.5 and an unrolled vtxo on regtest (F24)', () => {
  let wallet: Wallet
  let unrolled: { txid: string; vout: number }
  const esplora = new EsploraProvider(ESPLORA, { forcePolling: true, pollingInterval: 2000 })
  const indexer = new RestIndexerProvider(ARKD!)

  beforeAll(async () => {
    const identity = SingleKey.fromPrivateKey(randomBytes(32))
    wallet = await Wallet.create({
      identity,
      operatorProvider: new RestOperatorProvider(ARKD!),
      indexerProvider: indexer,
      onchainProvider: esplora,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    const address = await wallet.getAddress()
    for (const amount of [A, B]) {
      const note = ark('arkd', 'note', '--amount', String(amount + 2_000))
      ark('ark', 'redeem-notes', '-n', note, '--password', 'secret')
      ark('ark', 'send', '--to', address, '--amount', String(amount), '--password', 'secret')
    }
    const coins = await waitFor('both coins', async () => {
      const v = await wallet.getVtxos()
      return v.some((x) => x.value === A) && v.some((x) => x.value === B) ? v : undefined
    })
    const a = coins.find((x) => x.value === A)!
    unrolled = { txid: a.txid, vout: a.vout }

    // Fuel for the exit's CPFP children, then confirm the batch the coin hangs off.
    const fuel = await OnchainWallet.create(identity, 'regtest', esplora)
    regtest('faucet', fuel.address, '0.01')
    regtest('mine', '1')
    await waitFor('fuel', async () => ((await fuel.getBalance()) >= 500_000 ? true : undefined))

    const session = await Unroll.Session.create(unrolled, fuel, esplora, indexer)
    // next() broadcasts each package itself; mine to confirm and loop.
    for (let i = 0; i < 60; i++) {
      const step = await session.next()
      if (step.type === Unroll.StepType.DONE) break
      regtest('mine', '1')
      await Bun.sleep(1200)
    }
    await waitFor('arkd to mark the coin unrolled', async () => {
      const { vtxos } = await indexer.getVtxos({ outpoints: [unrolled] })
      return vtxos[0]?.isUnrolled ? true : undefined
    }, 180_000)
  }, 600_000)

  afterAll(async () => {
    await wallet?.dispose()
  })

  const isA = (v: { txid: string; vout: number }) => v.txid === unrolled.txid && v.vout === unrolled.vout

  test('arkd: unrolled, and NOT spent — the shape that leaked in 0.4.62', async () => {
    const { vtxos } = await indexer.getVtxos({ outpoints: [unrolled] })
    expect(vtxos[0]).toMatchObject({ isUnrolled: true, isSpent: false })
  })

  test('getVtxos / getSpendableVtxos leave it out; withUnrolled brings it back', async () => {
    expect((await wallet.getVtxos()).some(isA)).toBe(false)
    expect((await wallet.getVtxos({ withRecoverable: true })).some(isA)).toBe(false)
    expect((await wallet.getSpendableVtxos({ withRecoverable: true })).some(isA)).toBe(false)
    expect((await wallet.getVtxos({ withUnrolled: true })).some(isA)).toBe(true)
  })

  test('balance: its own unrolled bucket, never available or recoverable', async () => {
    const b = await wallet.getBalance()
    expect(b.unrolled).toBe(A)
    expect(b.available).toBe(B)
    expect(b.recoverable).toBe(0)
  })

  test('consolidate-all settles the live coin alone — no VTXO_ALREADY_UNROLLED', async () => {
    const before = (await wallet.getVtxos()).find((x) => x.value === B)!
    const txid = await wallet.settle()
    expect(txid).toMatch(/^[0-9a-f]{64}$/)
    // Regtest charges no intent fee, so the new coin keeps B's value — wait on the outpoint.
    const after = await waitFor('the consolidated coin', async () => {
      const v = await wallet.getVtxos()
      return v.length === 1 && v[0]!.txid !== before.txid ? v : undefined
    })
    expect(after[0]!.value).toBeLessThanOrEqual(B)
    expect(after.some(isA)).toBe(false)
    expect((await wallet.getBalance()).unrolled).toBe(A)
  }, 180_000)
})
