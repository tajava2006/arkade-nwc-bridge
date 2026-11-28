import '../../src/polyfills'
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hex } from '@scure/base'
import {
  ArkAddress,
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
} from '@arkade-os/sdk'
import {
  AtomicVtxoScript,
  refundSpend,
  serverUnrollScript,
  SqliteAtomicSwapRepository,
  SwapDirection,
  type AtomicOutput,
  type SharedVtxo,
} from '../../src/atomic'
import { refundAtomicSend } from '../../src/atomic/send'
import { openDatabase } from '../../src/db'

// The poisoned-txid false refund (mainnet 2026-07-17), ported from the SDK 0.4
// spike onto the solver harness (P5). The refund arkTx is deterministic and
// arkd keys its offchain event stream by arkTxid with full replay: a submit
// that fails the CLTV check (FORFEIT_CLOSURE_LOCKED while chain time < T)
// plants a Fail event, and a later submit of the SAME txid ACKs while the vtxo
// is never marked spent. refundAtomicSend must (1) gate on MTP, (2) verify the
// outpoint actually left the spendable set before bookkeeping, and (3) re-mint
// a fresh txid (regular + sub-dust split to ourselves) when the clean one is
// poisoned.
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/atomic_refund_poison.test.ts

const ARKD = process.env.REGTEST_ARKD_URL
const REGTEST_DIR = process.env.REGTEST_DIR
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'

const regtest = (...args: string[]) => execFileSync('node', [`${REGTEST_DIR}/regtest.mjs`, ...args], { encoding: 'utf8', cwd: REGTEST_DIR })
const sh = (c: string, ...a: string[]) =>
  execFileSync('docker', ['exec', c, ...a], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const waitFor = async <T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn().catch(() => undefined)
    if (v !== undefined) return v
    await Bun.sleep(500)
  }
  throw new Error(`timeout waiting for ${what}`)
}

describe.skipIf(!ARKD || !REGTEST_DIR)('poisoned refund txid on regtest', () => {
  test('a poisoned clean refund is detected and re-minted; never a false refund; the wallet is whole', async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'refund-poison-')), 'bridge.sqlite'))
    const repo = new SqliteAtomicSwapRepository(db)
    const ark = new RestArkProvider(ARKD!)
    const indexer = new RestIndexerProvider(ARKD!)
    const info = await ark.getInfo()
    const server = hex.decode(info.signerPubkey).subarray(1)
    const unroll = serverUnrollScript(info.checkpointTapscript)
    const a = 30
    const V = a + Number(info.dust)

    const identity = SingleKey.fromPrivateKey(randomBytes(32))
    const wallet = await Wallet.create({
      identity,
      operatorProvider: new RestOperatorProvider(ARKD!),
      indexerProvider: new RestIndexerProvider(ARKD!),
      onchainProvider: new EsploraProvider(ESPLORA, { forcePolling: true, pollingInterval: 2000 }),
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
      settlementConfig: false,
    })
    try {
      const address = await wallet.getAddress()
      const note = sh('arkd', 'arkd', 'note', '--amount', '21000')
      sh('arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
      sh('arkd', 'ark', 'send', '--to', address, '--amount', '20000', '--password', 'secret')
      await waitFor('funded', async () => ((await wallet.getBalance()).available >= 20_000 ? true : undefined))
      const startBalance = (await wallet.getBalance()).available

      // T ahead of BOTH the chain's MTP and the wall clock: a submit now is
      // CLTV-locked (the poison), and once the clock passes T, mined blocks
      // carry the MTP past it. (A T behind the wall clock only works when the
      // last blocks are old — not on a freshly started harness.)
      const tip = await (await fetch(`${ESPLORA}/blocks/tip/hash`)).text()
      const mtp = Number(((await (await fetch(`${ESPLORA}/block/${tip}`)).json()) as { mediantime: number }).mediantime)
      const T = BigInt(Math.max(mtp, Math.floor(Date.now() / 1000)) + 20)
      const H = randomBytes(32)
      const peer = await SingleKey.fromPrivateKey(randomBytes(32)).xOnlyPublicKey()
      const script = new AtomicVtxoScript({ funder: await identity.xOnlyPublicKey(), claimer: peer, server, paymentHash: H, refundLocktime: T, exitDelay: info.unilateralExitDelay })
      await wallet.send({ address: script.address('tark', server).encode(), amount: V })
      const v = await waitFor('the shared vtxo', async () =>
        (await indexer.getVtxos({ scripts: [hex.encode(script.pkScript)], spendableOnly: true })).vtxos.find((x) => x.value === V),
      )
      const shared: SharedVtxo = { txid: v.txid, vout: v.vout, value: v.value, script }

      repo.create({
        id: 'poison-swap',
        direction: SwapDirection.Send,
        paymentHash: hex.encode(H),
        state: 'init',
        amount: a,
        refundLocktime: Number(T),
        peerPubkey: hex.encode(peer),
        exitDelay: Number(info.unilateralExitDelay),
      })
      repo.setFundingOutpoint('poison-swap', `${shared.txid}:${shared.vout}`)
      repo.transition('poison-swap', 'funded')
      repo.transition('poison-swap', 'refund_wait')

      // POISON: the clean single-output refund while chain time < T.
      const cleanOutputs: AtomicOutput[] = [{ script: ArkAddress.decode(address).pkScript, amount: BigInt(V) }]
      let poisoned = false
      for (let i = 0; i < 3 && !poisoned; i++) {
        try {
          await refundSpend(shared, cleanOutputs, unroll, identity, ark)
          break
        } catch (e) {
          if (/FORFEIT_CLOSURE_LOCKED/.test(e instanceof Error ? e.message : String(e))) poisoned = true
        }
        await Bun.sleep(800)
      }
      expect(poisoned).toBe(true) // the clean txid now carries a Fail event

      // MTP past T: the clean txid would now ACK without registering.
      while (BigInt(Math.floor(Date.now() / 1000)) <= T + 5n) await Bun.sleep(1000)
      regtest('mine', '12')
      await Bun.sleep(2000)

      const res = await refundAtomicSend({ wallet, arkServerUrl: ARKD!, db, esploraUrl: ESPLORA }, 'poison-swap')
      expect(res.amount).toBe(V)
      expect(repo.get('poison-swap')?.state).toBe('refunded')
      // the decisive check: the shared vtxo is ACTUALLY spent — no false refund
      await Bun.sleep(2000)
      const left = (await indexer.getVtxos({ scripts: [hex.encode(script.pkScript)], spendableOnly: true })).vtxos
      expect(left.some((x) => x.txid === shared.txid && x.vout === shared.vout)).toBe(false)
      // whole on the total: the re-mint split leaves a few sats as sub-dust (recoverable)
      const total = await waitFor('the refund in the wallet', async () => {
        const b = await wallet.getBalance()
        const t = b.available + (b.recoverable ?? 0)
        return t >= startBalance ? t : undefined
      })
      expect(total).toBe(startBalance)
    } finally {
      await wallet.dispose()
    }
  }, 180_000)
})
