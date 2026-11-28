import '../../src/polyfills'
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { ArkSigner } from '../../subdustd/ark/signer'
import { FloatLock, FloatRenewer, lazyFloatManager } from '../../subdustd/float'

// subdustd's float upkeep (SM-29) on regtest: a renewal through the SDK's
// VtxoManager with the shape-keeping split, on a fresh key funded with two
// coins and a threshold that makes both due.
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/subdustd_float.test.ts

const ARKD = process.env.SUBDUSTD_ARKD_URL
const sh = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()
const silent = { debug() {}, info() {}, warn() {}, error() {} } as never

describe.skipIf(!ARKD)('subdustd float renewal on regtest', () => {
  test('due coins come back at their own values, on fresh outpoints with a later expiry', async () => {
    const signer = new ArkSigner(randomBytes(32), ARKD!)
    const address = (await signer.receiveAddress()).encode()
    for (const amount of [2000, 5000]) {
      const note = sh('exec', 'arkd', 'arkd', 'note', '--amount', String(amount + 1000))
      sh('exec', 'arkd', 'ark', 'redeem-notes', '-n', note, '--password', 'secret')
      sh('exec', 'arkd', 'ark', 'send', '--to', address, '--amount', String(amount), '--password', 'secret')
    }
    let before = await signer.ownVtxos()
    for (let i = 0; i < 60 && before.length < 2; i++) {
      await Bun.sleep(1000)
      before = await signer.ownVtxos()
    }
    expect(before.map((v) => v.value).sort((a, b) => a - b)).toEqual([2000, 5000])

    const renewer = new FloatRenewer({
      manager: lazyFloatManager({
        identity: signer.identity,
        operator: signer.ark,
        indexer: signer.indexer,
        expectedAddress: async () => address,
        chainHeight: async () => Number(await (await fetch(`${process.env.REGTEST_ESPLORA_URL ?? 'http://localhost:3000/api'}/blocks/tip/height`)).text()),
      }),
      lock: new FloatLock(),
      thresholdSecs: 10 * 86_400, // everything is due
      log: silent,
    })
    const r = await renewer.pass()
    expect(r.renewed).toMatch(/^[0-9a-f]{64}$/)

    let after = await signer.ownVtxos()
    for (let i = 0; i < 30 && after.some((v) => before.some((b) => b.txid === v.txid)); i++) {
      await Bun.sleep(1000)
      after = await signer.ownVtxos()
    }
    expect(after.map((v) => v.value).sort((a, b) => a - b)).toEqual([2000, 5000])
    expect(after.some((v) => before.some((b) => b.txid === v.txid && b.vout === v.vout))).toBe(false)
    const exp = (v: { expiresAt?: unknown }) => new Date(v.expiresAt as string).getTime()
    expect(Math.min(...after.map(exp))).toBeGreaterThan(Math.max(...before.map(exp)))
  }, 300_000)
})
