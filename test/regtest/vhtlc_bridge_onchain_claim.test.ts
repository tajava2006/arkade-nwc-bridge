import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
import type { Database } from 'bun:sqlite'
import { OnchainWallet, RestIndexerProvider, SingleKey, Unroll } from '@arkade-os/sdk'
import { SqliteAtomicSwapRepository } from '../../src/atomic'
import { driveAtomicReceive, issueAtomicReceive } from '../../src/atomic/receive'
import { BitcoindOnchainProvider, BitcoindRpc } from '../../src/chain/bitcoind'
import { findSpender } from '../../src/chain/spender'
import { openDatabase } from '../../src/db'
import { startExitEngine, type ExitEngine } from '../../src/exit/engine'
import { getExitOp } from '../../src/exit/ops'

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


// R5 from the bridge's side (F32_VHTLC_PLAN §5.4): the VHTLC of a receive is
// unrolled before the bridge claims it (the server, or anyone). arkd won't
// co-sign a claim of an unrolled vtxo; the bridge vaults the VHTLC, hands it
// to its exit engine, and after d_c the engine sweeps it through our claim
// leaf with the preimage — the claim subdustd then reads the preimage from.
// The exit engine runs on the bitcoind backend here.
//
// Moves the regtest clock (setmocktime, relative to MTP): run it alone or last.
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/vhtlc_bridge_onchain_claim.test.ts

const SUBDUSTD_URL = process.env.SUBDUSTD_URL
const ARKD = process.env.REGTEST_ARKD_URL ?? 'http://localhost:7070'
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'
const BITCOIND = process.env.REGTEST_BITCOIND_URL ?? 'http://localhost:18443'

const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 240_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

describe.skipIf(!SUBDUSTD_URL)('R5 on regtest: the VHTLC is unrolled before the bridge claims — the bridge claims on chain', () => {
  const rpc = new BitcoindRpc({ url: BITCOIND, user: 'admin1', password: '123' })
  const wallet = new BitcoindRpc({ url: `${BITCOIND}/wallet/default`, user: 'admin1', password: '123' })
  const chain = new BitcoindOnchainProvider(rpc)
  const identity = SingleKey.fromPrivateKey(randomBytes(32))
  const payers: ChildProcess[] = []
  let db: Database
  let engine: ExitEngine
  let miner: string
  let ticking: ReturnType<typeof setInterval> | undefined
  const mine = async (n: number) => void (await rpc.call('generatetoaddress', [n, miner]))

  beforeAll(async () => {
    db = openDatabase(join(mkdtempSync(join(tmpdir(), 'bridge-r5-')), 'bridge.sqlite'))
    engine = startExitEngine({
      db,
      identity,
      network: 'regtest',
      esploraUrls: [ESPLORA],
      providers: { bumper: await OnchainWallet.create(identity, 'regtest', chain), explorer: chain },
      pollIntervalMs: 1_000,
      log: (m) => console.log(m),
    })
    miner = await wallet.call<string>('getnewaddress', [])
    ticking = setInterval(() => void mine(1).catch(() => {}), 2_000)
  }, 60_000)

  afterAll(async () => {
    if (ticking) clearInterval(ticking)
    for (const p of payers) p.kill()
    engine?.stop()
    await releaseClock(rpc).catch(() => {})
  })

  test('unrolled by someone else → vaulted, unrolled to DONE, swept through our claim leaf with the preimage', async () => {
    const deps = { identity, arkServerUrl: ARKD, db, subdustdUrl: SUBDUSTD_URL!, startExit: (t: string, v: number) => engine.startExit(t, v) }
    const issued = await issueAtomicReceive(deps, 5_000, undefined, 'r5 drill')
    payers.push(spawn('docker', ['exec', 'lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', issued.invoice], { stdio: 'ignore' }))
    const st = await waitFor('subdustd funded the VHTLC', async () => {
      const s = (await (await fetch(`${SUBDUSTD_URL}/v2/subdust/atomic/receive/status?swapId=${issued.swapId}`)).json()) as any
      return s.state === 'funded' ? s : undefined
    })
    expect(st.script).toBe('vhtlc')
    const [txid, voutStr] = String(st.fundingOutpoint).split(':')
    const vout = Number(voutStr)

    // someone unrolls it before our claim (here a third key pays the CPFPs)
    const indexer = new RestIndexerProvider(ARKD)
    const other = await OnchainWallet.create(SingleKey.fromPrivateKey(randomBytes(32)), 'regtest', chain)
    await wallet.call('sendtoaddress', [other.address, 0.002])
    await waitFor('the other party’s fuel', async () => ((await chain.getCoins(other.address)).length > 0 ? true : undefined))
    // subdustd's executor notices the unroll and pushes the same packages; a
    // CPFP child that loses the anchor race throws — the next session resumes
    // from what's on chain (the same retry the bridge's reconciler does).
    await waitFor('the VHTLC confirmed on chain', async () => {
      try {
        const session = await Unroll.Session.create({ txid: txid!, vout }, other, chain, indexer)
        for await (const _ of session) {
          /* to DONE */
        }
      } catch (e) {
        console.log(`(unroll race: ${e instanceof Error ? e.message.slice(0, 80) : e} — again)`)
      }
      const status = await chain.getTxStatus(txid!).catch(() => ({ confirmed: false }))
      return status.confirmed ? true : undefined
    })
    await waitFor('arkd to flag the VHTLC unrolled', async () => {
      const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid: txid!, vout }] })
      return vtxos[0]?.isUnrolled ? true : undefined
    })

    // the bridge's pass: checks pass, the VHTLC is vaulted, and — unrolled — handed to the exit engine
    expect(await driveAtomicReceive(deps, issued.swapId)).toBe(false)
    const repo = new SqliteAtomicSwapRepository(db)
    expect(repo.get(issued.swapId)?.state).toBe('funded')
    await waitFor('the exit op waiting on d_c', () => (getExitOp(db, txid!, vout)?.state === 'waiting' ? true : undefined))

    // d_c passes: the engine sweeps through our claim leaf on its own
    const mtp = (await rpc.call<{ mediantime: number }>('getblockchaininfo')).mediantime
    await rpc.call('setmocktime', [Math.max(mtp, Math.floor(Date.now() / 1000)) + st.vhtlc.claimDelaySecs + 300])
    await mine(12)
    const op = await waitFor('swept', () => {
      const o = getExitOp(db, txid!, vout)
      return o?.state === 'swept' ? o : undefined
    })
    await waitFor('the sweep confirmed', async () => ((await chain.getTxStatus(op.sweepTxid!)).confirmed ? true : undefined))

    // the claim carries our preimage — what subdustd harvests to settle the payer
    const height = (await chain.getTxStatus(txid!)) as { blockHeight: number }
    const spent = await findSpender(chain, txid!, vout, height.blockHeight)
    expect(spent?.txid).toBe(op.sweepTxid!)
    expect(spent!.witness.some((w) => w.length === 32 && sha256(w) === issued.paymentHash)).toBe(true)
    expect(hex.encode(spent!.witness[1]!)).toBe(issued.preimage)

    // the next pass books it
    await driveAtomicReceive(deps, issued.swapId)
    expect(repo.get(issued.swapId)?.state).toBe('claimed')
  }, 600_000)
})
