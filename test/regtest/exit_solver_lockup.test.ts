import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import {
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
  type ExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { openDatabase } from '../../src/db'
import { exitPathsFor } from '../../src/exit/csv'
import { startExitEngine, type ExitEngine } from '../../src/exit/engine'
import { getExitOp } from '../../src/exit/ops'
import { syncProofs } from '../../src/exit/proof_sync'
import { getVaultVtxo } from '../../src/exit/vault'
import { startSolverRail, type SolverRail } from '../../src/solver_rail'

// SM-55: a solver lockup is the user's money in a covenant, and while a send
// sits 'stuck' (F31) it can stay there for days. If the ASP dies meanwhile, the
// bridge's exit tooling is the way out: the vault must hold the lockup's
// proofs, the engine must unroll it, and the sweep must spend the ONE leaf we
// can sign alone — unilateralRefundWithoutReceiver — not the solver's.
//
// Seconds-mode harness: the CSV is elapsed by moving bitcoind's clock forward
// (setmocktime + mining), so run this LAST in a session — later batches see
// the jump. eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/exit_solver_lockup.test.ts

const ARKD = process.env.REGTEST_ARKD_URL ?? 'http://localhost:7070'
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'
const REGTEST_DIR = process.env.REGTEST_DIR
const SOLVER_URL = process.env.SOLVER_URL
const CARD_PATH = process.env.SOLVER_CARD_PATH
const EMU = process.env.EMULATOR_PUBKEY_OVERRIDE

const regtest = (...args: string[]) => execFileSync('node', [`${REGTEST_DIR}/regtest.mjs`, ...args], { encoding: 'utf8', cwd: REGTEST_DIR })
const btc = (...args: string[]) => regtest('rpc', ...args).trim()
const sh = (c: string, ...a: string[]) =>
  execFileSync('docker', ['exec', c, ...a], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const peer = (...a: string[]): any => JSON.parse(sh('lnd-peer', 'lncli', '--network=regtest', ...a))
const sha256 = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 180_000, everyMs = 2000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    let v: T | undefined
    try {
      v = await fn()
    } catch {
      v = undefined
    }
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(everyMs)
  }
  throw new Error(`timeout waiting for ${what}`)
}

describe.skipIf(!REGTEST_DIR || !SOLVER_URL || !CARD_PATH || !EMU)('a stuck solver lockup, exited by the bridge on chain (SM-55)', () => {
  const identity = SingleKey.fromPrivateKey(randomBytes(32))
  let wallet: Wallet
  let db: Database
  let rail: SolverRail
  let engine: ExitEngine
  let lockup: ExtendedVirtualCoin
  let ourCsvSecs = 0

  beforeAll(async () => {
    wallet = await Wallet.create({
      identity,
      operatorProvider: new RestOperatorProvider(ARKD),
      indexerProvider: new RestIndexerProvider(ARKD),
      onchainProvider: new EsploraProvider(ESPLORA, { forcePolling: true, pollingInterval: 2000 }),
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    const note = sh('arkd', 'arkd', 'note', '--amount', '21000')
    sh('arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
    sh('arkd', 'ark', 'send', '--to', await wallet.getAddress(), '--amount', '20000', '--password', 'secret')
    await waitFor('funded', async () => ((await wallet.getBalance()).available >= 20_000 ? true : undefined))
    db = openDatabase(join(mkdtempSync(join(tmpdir(), 'exit-lockup-')), 'bridge.sqlite'))
    rail = await startSolverRail({
      wallet,
      db,
      network: 'regtest',
      arkInfo: () => new RestArkProvider(ARKD).getInfo(),
      lightning: { solverUrl: SOLVER_URL!, solverCard: JSON.parse(readFileSync(CARD_PATH!, 'utf8')), subdustdUrl: 'http://unused', emulatorPubkey: EMU! },
    })
  }, 300_000)

  afterAll(async () => {
    engine?.stop()
    try {
      btc('setmocktime', '0')
    } catch {
      /* best effort */
    }
    await rail?.dispose()
    await wallet?.dispose()
  })

  test('the stuck lockup is in the wallet view and its proofs are in the vault', async () => {
    const preimage = randomBytes(32).toString('hex')
    const hash = sha256(preimage)
    const bolt11 = peer('addholdinvoice', hash, '--amt', '5000').payment_request
    const res = await rail.client.pay(bolt11)
    const id = res.kind === 'swap' ? res.swap.id : ''
    await waitFor('the payee to hold the HTLC', () => (peer('lookupinvoice', hash).state === 'ACCEPTED' ? true : undefined))
    execFileSync('docker', ['stop', 'emulator'])
    try {
      peer('cancelinvoice', hash)
      await Bun.sleep(8000) // the solver tries the instant refund, fails, parks it stuck
    } finally {
      execFileSync('docker', ['start', 'emulator'])
    }
    expect((await rail.client.swaps()).find((s) => s.id === id)?.outcome).toBe('funded')

    const vtxos = await wallet.getVtxos({ withRecoverable: true })
    lockup = vtxos.find((v) => v.value === 5000)!
    expect(lockup).toBeDefined()
    const sync = await syncProofs(db, new RestIndexerProvider(ARKD) as never, vtxos, await identity.xOnlyPublicKey())
    expect(sync.failed).toEqual([])
    const row = getVaultVtxo(db, lockup.txid, lockup.vout)!
    expect(row.chain.length).toBeGreaterThan(0)
    expect(exitPathsFor(row.tapTree)).toHaveLength(3) // the solver's two and ours
    const ours = exitPathsFor(row.tapTree, await identity.xOnlyPublicKey())
    expect(ours).toHaveLength(1)
    ourCsvSecs = Number(ours[0]!.params.timelock.value)
    expect(ours[0]!.params.timelock.type).toBe('seconds')
  }, 300_000)

  test('the exit engine unrolls the lockup on chain to "waiting"', async () => {
    engine = startExitEngine({ db, identity, network: 'regtest', esploraUrls: [ESPLORA], pollIntervalMs: 2000 })
    const fuel = (await engine.fundingStatus()).address
    regtest('faucet', fuel, '0.01')
    regtest('mine', '1')
    await waitFor('the fuel visible', async () => (((await engine.fundingStatus()).balanceSat ?? 0) > 0 ? true : undefined))
    engine.startExit(lockup.txid, lockup.vout)
    await waitFor('unrolled and confirmed (waiting on the CSV)', () => {
      regtest('mine', '1')
      const op = getExitOp(db, lockup.txid, lockup.vout)
      if (op?.state === 'failed') throw new Error(`exit failed: ${JSON.stringify(op)}`)
      return op?.state === 'waiting' || op?.state === 'sweepable' ? true : undefined
    }, 300_000, 3000)
  }, 400_000)

  test('after OUR leaf\'s CSV, it is sweepable and the sweep lands the lockup value on our address', async () => {
    // Move chain time past our CSV: node clock forward, then enough blocks that
    // the median-time-past follows.
    const tipTime = Number(JSON.parse(btc('getblockheader', btc('getbestblockhash'))).mediantime)
    btc('setmocktime', String(tipTime + ourCsvSecs + 1200))
    regtest('mine', '12')
    await waitFor('sweepable', () => {
      regtest('mine', '1')
      return getExitOp(db, lockup.txid, lockup.vout)?.state === 'sweepable' ? true : undefined
    }, 180_000, 3000)

    const dest = (await engine.fundingStatus()).address
    const before = (await engine.fundingStatus()).balanceSat ?? 0
    const swept = await engine.sweep([{ txid: lockup.txid, vout: lockup.vout }], dest)
    expect(swept.txid).toMatch(/^[0-9a-f]{64}$/)
    regtest('mine', '1')
    const after = await waitFor('the sweep on our address', async () => {
      const b = (await engine.fundingStatus()).balanceSat ?? 0
      return b > before ? b : undefined
    })
    // the lockup value minus the sweep's mining fee
    expect(after - before).toBeGreaterThan(4000)
    expect(after - before).toBeLessThanOrEqual(5000)
    expect(getExitOp(db, lockup.txid, lockup.vout)?.state).toBe('swept')
  }, 300_000)
})
