import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { CSVMultisigTapscript, DefaultVtxo, type IndexerProvider, type OperatorInfo, type OperatorProvider } from '@arkade-os/sdk'
import { generateKeyFile, KeyFileError, loadKeyFile } from '../../subdustd/ark/key.ts'
import { arkdNetworkMismatch, ArkSigner } from '../../subdustd/ark/signer.ts'

const serverKey = secp256k1.utils.randomSecretKey()
const serverCompressed = secp256k1.getPublicKey(serverKey, true)
const serverXOnly = serverCompressed.subarray(1)
const checkpointTapscript = hex.encode(
  CSVMultisigTapscript.encode({ timelock: { type: 'blocks', value: 144n }, pubkeys: [serverXOnly] }).script,
)

const info = (o: Partial<OperatorInfo> = {}): OperatorInfo =>
  ({
    network: 'regtest',
    signerPubkey: hex.encode(serverCompressed),
    checkpointTapscript,
    unilateralExitDelay: 86_016n,
    dust: 330n,
    ...o,
  }) as OperatorInfo

const fakeArk = (answers: OperatorInfo[]) => {
  let calls = 0
  const ark = { getInfo: async () => answers[Math.min(calls++, answers.length - 1)]! } as unknown as OperatorProvider
  return { ark, calls: () => calls }
}

const KEY = hex.decode('11'.repeat(32))

describe('ArkSigner', () => {
  test('caches arkd info for the TTL, refetches after it or on force', async () => {
    const { ark, calls } = fakeArk([info(), info()])
    const cached = new ArkSigner(KEY, 'http://unused', { ark }, 60_000)
    await cached.getInfo()
    await cached.getInfo()
    expect(calls()).toBe(1)
    await cached.getInfo(true)
    expect(calls()).toBe(2)

    const { ark: ark2, calls: calls2 } = fakeArk([info()])
    const expiring = new ArkSigner(KEY, 'http://unused', { ark: ark2 }, -1)
    await expiring.getInfo()
    await expiring.getInfo()
    expect(calls2()).toBe(2)
  })

  test('own script follows the advertised exit delay — seconds at >= 512, blocks below', async () => {
    const seconds = new ArkSigner(KEY, 'http://unused', { ark: fakeArk([info({ unilateralExitDelay: 86_016n })]).ark })
    expect((await seconds.selfScript()).options.csvTimelock).toEqual({ type: 'seconds', value: 86_016n })
    expect(await seconds.selfDelay()).toBe(86_016n)

    const blocks = new ArkSigner(KEY, 'http://unused', { ark: fakeArk([info({ unilateralExitDelay: 144n })]).ark })
    expect((await blocks.selfScript()).options.csvTimelock).toEqual({ type: 'blocks', value: 144n })
  })

  test('own script is exactly what a counterparty rebuilds from (our x-only key, server key, advertised delay)', async () => {
    const signer = new ArkSigner(KEY, 'http://unused', { ark: fakeArk([info()]).ark })
    const rebuilt = new DefaultVtxo.Script({
      pubKey: secp256k1.getPublicKey(KEY, true).subarray(1),
      serverPubKey: serverXOnly,
      csvTimelock: { type: 'seconds', value: await signer.selfDelay() },
    })
    expect(hex.encode((await signer.selfScript()).pkScript)).toBe(hex.encode(rebuilt.pkScript))
    expect(await signer.xOnlyPublicKey()).toEqual(secp256k1.getPublicKey(KEY, true).subarray(1))
  })

  test('receive address uses the network HRP from arkd info', async () => {
    const main = new ArkSigner(KEY, 'http://unused', { ark: fakeArk([info({ network: 'bitcoin' })]).ark })
    const reg = new ArkSigner(KEY, 'http://unused', { ark: fakeArk([info({ network: 'regtest' })]).ark })
    expect((await main.receiveAddress()).encode()).toStartWith('ark1')
    expect((await reg.receiveAddress()).encode()).toStartWith('tark1')
  })

  test('own vtxos: queries only our script, spendable only, and follows every page (F23)', async () => {
    const seen: { scripts?: string[]; spendableOnly?: boolean; pageIndex?: number }[] = []
    const vtxo = (txid: string) => ({ txid, vout: 0, value: 1000, script: '', createdAt: new Date(), status: { confirmed: true } })
    const indexer = {
      getVtxos: async (opts: { scripts?: string[]; spendableOnly?: boolean; pageIndex?: number }) => {
        seen.push(opts)
        return (opts.pageIndex ?? 0) === 0
          ? { vtxos: [vtxo('aa'.repeat(32))], page: { current: 1, next: 1, total: 2 } }
          : { vtxos: [vtxo('bb'.repeat(32))], page: { current: 2, next: 2, total: 2 } }
      },
    } as unknown as IndexerProvider
    const signer = new ArkSigner(KEY, 'http://unused', { ark: fakeArk([info()]).ark, indexer })
    const own = await signer.ownVtxos()
    expect(own.map((v) => v.txid)).toEqual(['aa'.repeat(32), 'bb'.repeat(32)])
    const script = hex.encode((await signer.selfScript()).pkScript)
    expect(seen.map((s) => [s.scripts, s.spendableOnly])).toEqual([
      [[script], true],
      [[script], true],
    ])
  })

  test('arkd on another network than the config is a mismatch', () => {
    expect(arkdNetworkMismatch('regtest', info({ network: 'regtest' }))).toBeUndefined()
    expect(arkdNetworkMismatch('bitcoin', info({ network: 'regtest' }))).toContain('arkd is on regtest but config.network is bitcoin')
  })
})

describe('key file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subdustd-key-'))

  test('keygen writes a 600-mode hex secret that loads back, and never overwrites', () => {
    const path = join(dir, 'k1')
    const key = generateKeyFile(path)
    expect(readFileSync(path, 'utf8')).toBe(`${hex.encode(key)}\n`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(loadKeyFile(path)).toEqual({ key, warnings: [] })
    expect(() => generateKeyFile(path)).toThrow('already exists — refusing to overwrite a key')
    expect(readFileSync(path, 'utf8')).toBe(`${hex.encode(key)}\n`)
  })

  test('rejects anything that is not a valid secret key', () => {
    const cases: [string, string][] = [
      ['short', 'ab'.repeat(31)],
      ['nothex', 'zz'.repeat(32)],
      ['zero', '00'.repeat(32)],
      ['overorder', 'ff'.repeat(32)],
    ]
    for (const [name, body] of cases) {
      const path = join(dir, name)
      writeFileSync(path, body, { mode: 0o600 })
      expect(() => loadKeyFile(path)).toThrow(KeyFileError)
    }
    expect(() => loadKeyFile(join(dir, 'absent'))).toThrow(KeyFileError)
  })

  test('warns when the key file is readable by others', () => {
    const path = join(dir, 'loose')
    writeFileSync(path, '11'.repeat(32))
    chmodSync(path, 0o644)
    expect(loadKeyFile(path).warnings).toEqual([`${path} is readable by group/other — chmod 600`])
  })
})
