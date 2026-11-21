import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { hex } from '@scure/base'
import {
  ArkAddress,
  EsploraProvider,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestIndexerProvider,
  RestOperatorProvider,
  SingleKey,
  Wallet,
} from '@arkade-os/sdk'

// F23 re-check on SDK 0.5 (SM-32): does the stock SDK wallet — no bridge
// WholeSetIndexerProvider — see every vtxo of a wallet that holds more than one
// arkd page (100, clamped server-side since v0.9.16), with spent rows mixed in?
// The 0.4 pager stopped after page 1 and silently dropped the OLDEST rows.
//
//   REGTEST_ARKD_URL=http://localhost:7070 bun test test/regtest/sdk05_pager.test.ts

const ARKD = process.env.REGTEST_ARKD_URL
const ESPLORA = process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'
const COINS = 160 // > 1.5 arkd pages
const PER_TX = 40
const VALUE = 400

const ark = (...args: string[]) =>
  execFileSync('docker', ['exec', 'arkd', ...args], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()

const stockWallet = (key: Uint8Array) =>
  Wallet.create({
    identity: SingleKey.fromPrivateKey(key),
    operatorProvider: new RestOperatorProvider(ARKD!),
    indexerProvider: new RestIndexerProvider(ARKD!), // the SDK's own, unpatched
    onchainProvider: new EsploraProvider(ESPLORA, { forcePolling: true, pollingInterval: 2000 }),
    storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
    settlementConfig: false,
  })

const waitFor = async <T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined) return v
    await Bun.sleep(1000)
  }
  throw new Error(`timeout waiting for ${what}`)
}

describe.skipIf(!ARKD)('SDK 0.5 vtxo pager on regtest (F23)', () => {
  let funder: Wallet
  let target: Wallet
  let targetScript: string

  /** Ground truth straight from arkd, one unpaged request (arkd's uncapped path). */
  const truth = async (): Promise<string[]> => {
    const res = await fetch(`${ARKD}/v1/indexer/vtxos?scripts=${targetScript}&spendableOnly=true`)
    const body = (await res.json()) as { vtxos: { outpoint: { txid: string; vout: number } }[] }
    return body.vtxos.map((v) => `${v.outpoint.txid}:${v.outpoint.vout}`).sort()
  }

  beforeAll(async () => {
    funder = await stockWallet(randomBytes(32))
    target = await stockWallet(randomBytes(32))
    targetScript = hex.encode(ArkAddress.decode(await target.getAddress()).pkScript)
    const note = ark('arkd', 'note', '--amount', String(COINS * VALUE + 20_000))
    ark('ark', 'redeem-notes', '-n', note, '--password', 'secret')
    ark('ark', 'send', '--to', await funder.getAddress(), '--amount', String(COINS * VALUE + 10_000), '--password', 'secret')
    await waitFor('the funder float', async () => ((await funder.getBalance()).available >= COINS * VALUE ? true : undefined))
    const to = await target.getAddress()
    for (let sent = 0; sent < COINS; sent += PER_TX) {
      const recipients = Array.from({ length: PER_TX }, () => ({ address: to, amount: VALUE }))
      await funder.send(...(recipients as [{ address: string; amount: number }, ...{ address: string; amount: number }[]]))
    }
    await waitFor(`${COINS} coins on the target`, async () => ((await truth()).length >= COINS ? true : undefined))
  }, 600_000)

  afterAll(async () => {
    await funder?.dispose?.()
    await target?.dispose?.()
  })

  test('arkd still clamps a page at 100 — the condition that broke 0.4', async () => {
    const res = await fetch(`${ARKD}/v1/indexer/vtxos?scripts=${targetScript}&spendableOnly=true&page.size=500&page.index=0`)
    const body = (await res.json()) as { vtxos: unknown[]; page?: { current: number; next: number; total: number } }
    console.log(`arkd page for size=500 index=0: ${body.vtxos.length} rows, page=${JSON.stringify(body.page)}`)
    expect(body.vtxos.length).toBe(100)
  })

  test('the stock SDK wallet sees every coin, with spent rows mixed in', async () => {
    // Spend some coins so the script also carries spent rows (the 0.4 sync
    // query had no filter, and spent rows pushed live ones off page 1).
    await target.send({ address: await funder.getAddress(), amount: VALUE * 5 })
    const expected = await waitFor('the post-spend set to settle', async () => {
      const t = await truth()
      return t.length < COINS ? t : undefined
    })
    const seen = (await target.getVtxos({ withRecoverable: true })).map((v) => `${v.txid}:${v.vout}`).sort()
    console.log(`truth ${expected.length} live coins, stock SDK wallet sees ${seen.length}`)
    expect(expected.length).toBeGreaterThan(100)
    expect(seen).toEqual(expected)
    const spendable = await target.getSpendableVtxos({ withRecoverable: true })
    expect(spendable.length).toBe(expected.length)
    expect((await target.getBalance()).available).toBe(spendable.reduce((n, v) => n + v.value, 0))
  }, 300_000)
})
