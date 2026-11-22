import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
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
} from '@arkade-os/sdk'
import type { Swap } from '@arkade-os/swap'
import { openDatabase } from '../../src/db'
import type { LightningConfig } from '../../src/lightning_config'
import { startSolverRail, type SolverRail } from '../../src/solver_rail'
import { openSwapRepository } from '../../src/swap_store'

// The bridge's solver rail (SM-42) against the regtest-solver harness: our
// patched intent-solver, our emulator, LND 0.21.5.
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/solver_rail.test.ts

const SOLVER_URL = process.env.SOLVER_URL
const CARD_PATH = process.env.SOLVER_CARD_PATH
const EMU = process.env.EMULATOR_PUBKEY_OVERRIDE
const ARKD = process.env.REGTEST_ARKD_URL ?? 'http://localhost:7070'
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'

const sh = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const peer = (...args: string[]): any => JSON.parse(sh('exec', 'lnd-peer', 'lncli', '--network=regtest', ...args))
const sha256 = (h: string) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex')
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 120_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const payers: ChildProcess[] = []
const peerPays = (bolt11: string) =>
  payers.push(spawn('docker', ['exec', 'lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', bolt11], { stdio: 'ignore' }))

describe.skipIf(!SOLVER_URL || !CARD_PATH || !EMU)('solver rail on regtest', () => {
  let wallet: Wallet
  let db: Database
  let rail: SolverRail
  let lightning: LightningConfig
  const arkInfo = () => new RestArkProvider(ARKD).getInfo()

  const outcomeOf = async (id: string): Promise<Swap | undefined> => (await rail.client.swaps()).find((s) => s.id === id)
  const until = (id: string, outcome: string) =>
    waitFor(`${id} → ${outcome}`, async () => {
      const s = await outcomeOf(id)
      return s?.outcome === outcome ? s : undefined
    })

  beforeAll(async () => {
    wallet = await Wallet.create({
      identity: SingleKey.fromPrivateKey(randomBytes(32)),
      operatorProvider: new RestOperatorProvider(ARKD),
      indexerProvider: new RestIndexerProvider(ARKD),
      onchainProvider: new EsploraProvider(ESPLORA, { forcePolling: true, pollingInterval: 2000 }),
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    const note = sh('exec', 'arkd', 'arkd', 'note', '--amount', '60000')
    sh('exec', 'arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
    sh('exec', 'arkd', 'ark', 'send', '--to', await wallet.getAddress(), '--amount', '50000', '--password', 'secret')
    await waitFor('the wallet funded', async () => ((await wallet.getBalance()).available >= 50_000 ? true : undefined))
    db = openDatabase(join(mkdtempSync(join(tmpdir(), 'bridge-rail-')), 'bridge.sqlite'))
    lightning = {
      solverUrl: SOLVER_URL!,
      solverCard: JSON.parse(readFileSync(CARD_PATH!, 'utf8')),
      subdustdUrl: 'http://unused',
      emulatorPubkey: EMU!,
    }
    rail = await startSolverRail({ wallet, db, lightning, network: 'regtest', arkInfo })
  }, 300_000)

  afterAll(async () => {
    for (const p of payers) p.kill()
    await rail?.dispose()
    await wallet?.dispose()
  })

  test('pay: the solver pays the invoice; the record holds the hash-verified preimage NWC needs', async () => {
    const inv = peer('addinvoice', '--amt', '5000')
    const res = await rail.client.pay(inv.payment_request)
    expect(res.kind).toBe('swap')
    const id = res.kind === 'swap' ? res.swap.id : ''
    const paid = await until(id, 'paid')
    expect(paid.lock?.hash).toBe(inv.r_hash)
    expect(peer('lookupinvoice', inv.r_hash).state).toBe('SETTLED')
    const record = (await openSwapRepository(db).getSwapRecord(id.split(':')[1]!)) as { settlementPreimageHex?: string }
    expect(record.settlementPreimageHex).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256(record.settlementPreimageHex!)).toBe(inv.r_hash)
  }, 300_000)

  test('receive: the drive claims by itself once the payer pays', async () => {
    const before = (await wallet.getBalance()).available
    const r = await rail.client.receive({ amount: 7_000n, via: 'lightning' })
    peerPays(r.artifact.bolt11)
    await until(r.id, 'claimed')
    await waitFor('the claim to land', async () => ((await wallet.getBalance()).available >= before + 7_000 ? true : undefined))
  }, 300_000)

  test('a failed pay comes back at once through our emulator (no timelock wait)', async () => {
    const preimage = randomBytes(32).toString('hex')
    const hash = sha256(preimage)
    const bolt11 = peer('addholdinvoice', hash, '--amt', '5000').payment_request
    const before = (await wallet.getBalance()).available
    const res = await rail.client.pay(bolt11)
    const id = res.kind === 'swap' ? res.swap.id : ''
    await waitFor('the payee to hold the HTLC', () => (peer('lookupinvoice', hash).state === 'ACCEPTED' ? true : undefined))
    peer('cancelinvoice', hash)
    await until(id, 'refunded')
    await waitFor('the refund back in the wallet', async () => ((await wallet.getBalance()).available >= before ? true : undefined))
  }, 300_000)

  test('a restart resumes a live swap from the store: a receive issued before, paid after, still claims', async () => {
    const before = (await wallet.getBalance()).available
    const r = await rail.client.receive({ amount: 6_000n, via: 'lightning' })
    await rail.dispose()
    rail = await startSolverRail({ wallet, db, lightning, network: 'regtest', arkInfo })
    expect((await rail.client.swaps()).length).toBeGreaterThanOrEqual(4)
    peerPays(r.artifact.bolt11)
    await until(r.id, 'claimed')
    await waitFor('the claim to land', async () => ((await wallet.getBalance()).available >= before + 6_000 ? true : undefined))
  }, 300_000)
})
