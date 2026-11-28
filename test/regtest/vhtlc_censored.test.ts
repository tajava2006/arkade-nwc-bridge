import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
import type { Database } from 'bun:sqlite'
import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  OnchainWallet,
  RestArkProvider,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
} from '@arkade-os/sdk'
import { SqliteAtomicSwapRepository } from '../../src/atomic'
import { driveAtomicReceive, issueAtomicReceive } from '../../src/atomic/receive'
import { atomicSubdustSend, resumeAtomicSends } from '../../src/atomic/send'
import { policyFor, receiveClaimDeadline, unrollDeadline } from '../../src/atomic/vhtlc'
import { BitcoindOnchainProvider, BitcoindRpc } from '../../src/chain/bitcoind'
import { findSpender } from '../../src/chain/spender'
import { openDatabase } from '../../src/db'
import { startExitEngine, type ExitEngine } from '../../src/exit/engine'
import { getExitOp } from '../../src/exit/ops'
import { getVaultVtxo } from '../../src/exit/vault'

// The operator censors (F32_VHTLC_PLAN §5): arkd takes everything but the
// one transaction that would settle the user's side. A proxy in front of arkd
// refuses /v1/tx/submit on cue; the bridge runs its real code against it.
//   R1 — a receive's claim is refused. At the R1 deadline the bridge claims on
//        chain (unroll, d_c, preimage leaf) before T; subdustd reads the
//        preimage out of that claim and settles the payer — nobody loses.
//   S4 — a send's T refund is refused and subdustd is gone. At the unroll
//        deadline (before the batch can be swept) the bridge unrolls and takes
//        the funding back through its lone leaf after d_s.
// The deadlines are wall-clock checks in the bridge, so the drill moves the
// process clock (setSystemTime) for that one pass; chain time moves with
// setmocktime relative to MTP. Run it alone or last.
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/vhtlc_censored.test.ts

const SUBDUSTD_URL = process.env.SUBDUSTD_URL
const ARKD = process.env.REGTEST_ARKD_URL ?? 'http://localhost:7070'
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'
const BITCOIND = process.env.REGTEST_BITCOIND_URL ?? 'http://localhost:18443'

/** See vhtlc_executor_receive: setmocktime 0 with MTP > 2h ahead stalls mining. */
const releaseClock = async (rpc: { call<T>(m: string, p?: unknown[]): Promise<T> }) => {
  const mtp = (await rpc.call<{ mediantime: number }>('getblockchaininfo')).mediantime
  const now = Math.floor(Date.now() / 1000)
  await rpc.call('setmocktime', [mtp < now + 3_600 ? 0 : mtp + 1])
}
const sh = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const peer = (...args: string[]): any => JSON.parse(sh('exec', 'lnd-peer', 'lncli', '--network=regtest', ...args))
const sha256hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
// performance.now, not Date.now: the drill moves the process clock
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 300_000): Promise<T> => {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    const v = await fn()
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}
/** Run `pass` with the process clock at `atSecs`, then hand the clock back. */
const at = async <T>(atSecs: number, pass: () => Promise<T>): Promise<T> => {
  setSystemTime(new Date(atSecs * 1000))
  try {
    return await pass()
  } finally {
    setSystemTime()
  }
}

/** A pass-through proxy that refuses whatever `refuse` picks. */
const proxy = (upstream: string, refuse: (req: Request, path: string) => boolean) => {
  const state = { on: false, refused: 0 }
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0, // SSE streams pass through
    async fetch(req) {
      const u = new URL(req.url)
      if (state.on && refuse(req, u.pathname)) {
        state.refused++
        return Response.json({ code: 13, message: 'refused by the drill proxy' }, { status: 500 })
      }
      const headers = new Headers(req.headers)
      headers.delete('host')
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
      return fetch(upstream + u.pathname + u.search, { method: req.method, headers, body })
    },
  })
  return { state, url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}

describe.skipIf(!SUBDUSTD_URL)('the operator censors: the bridge settles its side on chain', () => {
  const rpc = new BitcoindRpc({ url: BITCOIND, user: 'admin1', password: '123' })
  const btc = new BitcoindRpc({ url: `${BITCOIND}/wallet/default`, user: 'admin1', password: '123' })
  const chain = new BitcoindOnchainProvider(rpc)
  // arkd minus /v1/tx/submit; subdustd minus /send/fund (S4: "gone" once funded)
  const arkd = proxy(ARKD, (req, path) => req.method === 'POST' && path === '/v1/tx/submit')
  const subdustd = proxy(SUBDUSTD_URL ?? 'http://localhost:1', (_req, path) => path.endsWith('/atomic/send/fund'))
  const payers: ChildProcess[] = []
  let miner: string
  let ticking: ReturnType<typeof setInterval> | undefined
  let exitDelay: number
  const mine = async (n: number) => void (await rpc.call('generatetoaddress', [n, miner]))
  const jumpPast = async (secs: number) => {
    const mtp = (await rpc.call<{ mediantime: number }>('getblockchaininfo')).mediantime
    await rpc.call('setmocktime', [Math.max(mtp, Math.floor(Date.now() / 1000)) + secs + 300])
    await mine(12)
  }
  /** A bridge identity with its exit engine (bitcoind backend) and CPFP fuel. */
  const bridge = async (label: string) => {
    const identity = SingleKey.fromPrivateKey(randomBytes(32))
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), `bridge-${label}-`)), 'bridge.sqlite'))
    const fuel = await OnchainWallet.create(identity, 'regtest', chain)
    await btc.call('sendtoaddress', [fuel.address, 0.002])
    await waitFor('the exit fuel', async () => ((await chain.getCoins(fuel.address)).length > 0 ? true : undefined))
    const engine = startExitEngine({
      db,
      identity,
      network: 'regtest',
      esploraUrls: [ESPLORA],
      providers: { bumper: fuel, explorer: chain },
      pollIntervalMs: 1_000,
      log: (m) => console.log(m),
    })
    return { identity, db, fuel, engine, startExit: (t: string, v: number) => engine.startExit(t, v) }
  }
  const engines: ExitEngine[] = []

  beforeAll(async () => {
    miner = await btc.call<string>('getnewaddress', [])
    exitDelay = Number((await new RestArkProvider(ARKD).getInfo()).unilateralExitDelay)
    ticking = setInterval(() => void mine(1).catch(() => {}), 2_000)
  }, 60_000)

  afterAll(async () => {
    if (ticking) clearInterval(ticking)
    for (const p of payers) p.kill()
    for (const e of engines) e.stop()
    arkd.stop()
    subdustd.stop()
    await releaseClock(rpc).catch(() => {})
  })

  test('R1: our claim is refused → at the deadline the bridge claims on chain, before T, and subdustd still settles', async () => {
    arkd.state.on = subdustd.state.on = false
    // a fresh float coin: earlier unrolls dragged float change on chain
    const floatAddr = execFileSync('sh', ['-c', "docker logs subdustd 2>&1 | grep -oE 'top-up address tark1[a-z0-9]+' | tail -1"], { encoding: 'utf8' })
      .trim()
      .split(' ')
      .pop()!
    const note = sh('exec', 'arkd', 'arkd', 'note', '--amount', '21000')
    sh('exec', 'arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
    sh('exec', 'arkd', 'ark', 'send', '--to', floatAddr, '--amount', '20000', '--password', 'secret')
    const b = await bridge('r1')
    engines.push(b.engine)
    const deps = { identity: b.identity, arkServerUrl: arkd.url, db: b.db, subdustdUrl: SUBDUSTD_URL!, startExit: b.startExit }
    const issued = await issueAtomicReceive(deps, 5_000, undefined, 'r1 drill')
    payers.push(spawn('docker', ['exec', 'lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', issued.invoice], { stdio: 'ignore' }))
    const st = await waitFor('subdustd funded the VHTLC', async () => {
      const s = (await (await fetch(`${SUBDUSTD_URL}/v2/subdust/atomic/receive/status?swapId=${issued.swapId}`)).json()) as any
      return s.state === 'funded' ? s : undefined
    })
    expect(st.script).toBe('vhtlc')
    const [txid, voutStr] = String(st.fundingOutpoint).split(':')
    const vout = Number(voutStr)
    const repo = new SqliteAtomicSwapRepository(b.db)

    // the claim goes out and arkd refuses it — vaulted first, the row is funded
    arkd.state.on = true
    await expect(driveAtomicReceive(deps, issued.swapId)).rejects.toThrow()
    expect(arkd.state.refused).toBeGreaterThan(0)
    expect(repo.get(issued.swapId)?.state).toBe('funded')
    expect(getVaultVtxo(b.db, txid!, vout)?.source).toBe('atomic')

    // before the deadline the bridge keeps trying offchain (refused again) — nothing on chain yet
    await expect(driveAtomicReceive(deps, issued.swapId)).rejects.toThrow()
    expect(getExitOp(b.db, txid!, vout)).toBeNull()

    // at the deadline (T − d_c − detect/unroll/confirm): handed to the exit engine
    const deadline = receiveClaimDeadline(policyFor(exitDelay, 'regtest'), st.refundLocktime, st.vhtlc.claimDelaySecs)
    expect(deadline).toBeLessThan(st.refundLocktime)
    await at(deadline + 30, () => driveAtomicReceive(deps, issued.swapId))
    expect(getExitOp(b.db, txid!, vout)).not.toBeNull()

    // unrolled (subdustd's executor joins in; a lost anchor race is retried by the reconciler)
    await waitFor('the exit op waiting on d_c', async () => {
      await driveAtomicReceive(deps, issued.swapId).catch(() => {})
      return getExitOp(b.db, txid!, vout)?.state === 'waiting' ? true : undefined
    })
    const vhtlcHeight = ((await chain.getTxStatus(txid!)) as { blockHeight: number }).blockHeight

    // d_c: swept through the claim leaf with the preimage
    await jumpPast(st.vhtlc.claimDelaySecs)
    const op = await waitFor('swept', () => {
      const o = getExitOp(b.db, txid!, vout)
      return o?.state === 'swept' ? o : undefined
    })
    const spent = await waitFor('our claim on chain', () => findSpender(chain, txid!, vout, vhtlcHeight).then((s) => s ?? undefined))
    expect(spent.txid).toBe(op.sweepTxid!)
    expect(spent.witness.some((w) => w.length === 32 && sha256hex(w) === issued.paymentHash)).toBe(true)

    // subdustd's change in the same Ark tx came on chain with the VHTLC: swept back to its fuel after the exit delay
    // outputs: the VHTLC, subdustd's change (when any), the P2A anchor
    const { vout: outs } = await rpc.call<{ vout: unknown[] }>('getrawtransaction', [txid, true])
    if (outs.length > 2) {
      await waitFor('subdustd sweeping its unrolled change', async () => ((await chain.getTxOutspends(txid!))[1]?.spent ? true : undefined))
    }

    // subdustd harvests the preimage from that claim and settles; the payer is paid, the row converges
    await waitFor('the payer to see SUCCEEDED', () =>
      peer('listpayments', '--include_incomplete', '--max_payments', '300').payments.find((p: any) => p.payment_hash === issued.paymentHash)?.status ===
      'SUCCEEDED'
        ? true
        : undefined,
    )
    await waitFor('settled', async () => {
      await driveAtomicReceive(deps, issued.swapId).catch(() => {})
      return repo.get(issued.swapId)?.state === 'settled' ? true : undefined
    })
  }, 900_000)

  test('S4: the T refund is refused and subdustd is gone → at the unroll deadline the bridge takes the funding back on chain', async () => {
    arkd.state.on = subdustd.state.on = false
    const b = await bridge('s4')
    engines.push(b.engine)
    const wallet = await Wallet.create({
      identity: b.identity,
      operatorProvider: new RestOperatorProvider(arkd.url),
      indexerProvider: new RestIndexerProvider(arkd.url),
      onchainProvider: chain,
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    try {
      const note = sh('exec', 'arkd', 'arkd', 'note', '--amount', '7000')
      sh('exec', 'arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
      sh('exec', 'arkd', 'ark', 'send', '--to', await wallet.getAddress(), '--amount', '6000', '--password', 'secret')
      await waitFor('the wallet funded', async () => ((await wallet.getBalance()).available >= 6_000 ? true : undefined))
      // no esploraUrl: the refund's MTP pre-check would only say "not yet" — the drill moves the process clock instead
      const deps = { wallet, arkServerUrl: arkd.url, db: b.db, subdustdUrl: subdustd.url, startExit: b.startExit }
      const inv = peer('addinvoice', '--amt', '5000')

      // funded, then subdustd never hears of it: the swap sits at ln_inflight with nobody to pay or cancel
      subdustd.state.on = true
      await expect(atomicSubdustSend(deps, inv.payment_request, 5_000)).rejects.toThrow()
      const repo = new SqliteAtomicSwapRepository(b.db)
      const swap = repo.listResumable().find((s) => s.paymentHash === inv.r_hash)!
      expect(swap.state).toBe('ln_inflight')
      expect(swap.vhtlc).toBeTruthy()
      const [txid, voutStr] = swap.fundingOutpoint!.split(':')
      const vout = Number(voutStr)
      const vaulted = getVaultVtxo(b.db, txid!, vout)!
      expect(vaulted.expiresAt).toBeGreaterThan(swap.refundLocktime)

      // past T, arkd refusing the refund — but not yet at the unroll deadline: keep trying offchain
      arkd.state.on = true
      const deadline = unrollDeadline(policyFor(0, 'regtest'), vaulted.expiresAt!)
      const early = Math.max(swap.refundLocktime + 30, deadline - 300)
      expect(early).toBeLessThan(deadline)
      const r1 = await at(early, () => resumeAtomicSends(deps))
      expect(r1.failed.map((f) => f.id)).toContain(swap.id)
      expect(getExitOp(b.db, txid!, vout)).toBeNull()

      // at the deadline: unrolled while the batch still stands
      const before = (await chain.getCoins(b.fuel.address)).reduce((n, c) => n + c.value, 0)
      const r2 = await at(deadline + 30, () => resumeAtomicSends(deps))
      expect(r2.failed.map((f) => f.id)).toContain(swap.id)
      expect(getExitOp(b.db, txid!, vout)).not.toBeNull()
      // the reconciler's pass (every 30s in the bridge) restarts an exit that lost a race
      await waitFor('the exit op waiting on d_s', async () => {
        await resumeAtomicSends(deps).catch(() => {})
        return getExitOp(b.db, txid!, vout)?.state === 'waiting' ? true : undefined
      })

      // d_s: our lone leaf, swept to the fuel address; the next pass books it refunded
      await jumpPast(swap.vhtlc!.refundNoReceiverDelaySecs)
      const op = await waitFor('swept', () => {
        const o = getExitOp(b.db, txid!, vout)
        return o?.state === 'swept' ? o : undefined
      })
      await waitFor('the sweep confirmed', async () => ((await chain.getTxStatus(op.sweepTxid!)).confirmed ? true : undefined))
      const after = (await chain.getCoins(b.fuel.address)).reduce((n, c) => n + c.value, 0)
      // the whole funding back, less the unroll CPFPs and the sweep fee
      expect(after - before).toBeGreaterThan(vaulted.valueSat - 3_000)
      await resumeAtomicSends(deps)
      expect(repo.get(swap.id)?.state).toBe('refunded')
      expect(inv.r_hash).toBe(swap.paymentHash)
      expect(hex.decode(swap.paymentHash).length).toBe(32)
    } finally {
      await wallet.dispose()
    }
  }, 900_000)
})
