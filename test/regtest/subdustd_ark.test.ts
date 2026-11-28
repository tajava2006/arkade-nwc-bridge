import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { hex } from '@scure/base'
import { SingleKey, type ArkTxInput } from '@arkade-os/sdk'
import { AtomicVtxoScript, cancelSpend, fundShared, type SharedVtxo } from '../../src/atomic/index.ts'
import { arkdNetworkMismatch, ArkSigner } from '../../subdustd/ark/signer.ts'

// subdustd's key-only Ark side against a real (fork) arkd on regtest, as the
// FUNDER of a receive: top up its address, pick funding ascending + whole,
// fund a shared 4-leaf vtxo, then unwind it through the cancel leaf back to
// its own script. Proves SDK 0.5 key-only signing over its own forfeit leaf
// and the shared script end to end.
//
//   SUBDUSTD_ARKD_URL=http://localhost:7070 bun test test/regtest/subdustd_ark.test.ts
//
// Tops up from the arkd container's own wallet (`arkd note` + `ark send`).

const ARKD_URL = process.env.SUBDUSTD_ARKD_URL
const ARKD_CONTAINER = process.env.SUBDUSTD_ARKD_CONTAINER ?? 'arkd'

const arkCli = (...args: string[]) =>
  execFileSync('docker', ['exec', ARKD_CONTAINER, ...args], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => !l.includes('WARN'))
    .join('\n')
    .trim()

const topUp = (address: string, amount: number) => {
  const note = arkCli('arkd', 'note', '--amount', String(amount + 1000))
  arkCli('ark', 'redeem-notes', '-n', note, '--password', 'secret')
  arkCli('ark', 'send', '--to', address, '--amount', String(amount), '--password', 'secret')
}

const waitFor = async <T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v !== undefined) return v
    await Bun.sleep(500)
  }
  throw new Error(`timeout waiting for ${what}`)
}

describe.skipIf(!ARKD_URL)('subdustd ArkSigner on regtest', () => {
  let signer: ArkSigner

  beforeAll(() => {
    signer = new ArkSigner(randomBytes(32), ARKD_URL!)
  })
  afterAll(() => {})

  test('arkd info: right network, own script on the advertised delay', async () => {
    const info = await signer.getInfo()
    expect(arkdNetworkMismatch('regtest', info)).toBeUndefined()
    expect(await signer.selfDelay()).toBe(info.unilateralExitDelay)
    expect((await signer.receiveAddress()).encode()).toStartWith('tark1')
  })

  test('fund a shared vtxo from its own float (ascending, whole) and unwind it via cancel', async () => {
    const info = await signer.getInfo()
    const dust = Number(info.dust)
    const address = (await signer.receiveAddress()).encode()
    const small = dust + 70
    const large = 5_000
    topUp(address, large)
    topUp(address, small)
    const own = await waitFor('both top-ups on our script', async () => {
      const v = await signer.ownVtxos()
      return v.some((x) => x.value === small) && v.some((x) => x.value === large) ? v : undefined
    })
    expect(own.length).toBe(2)

    // a = 21 → V = dust + 21. The smaller coin already covers it, so it funds alone.
    const T = BigInt(Math.floor(Date.now() / 1000) + 600)
    const funding = await signer.selectFunding({ dust, refundLocktime: T, marginSecs: 60, amount: 21 })
    expect(funding.map((v) => v.value)).toEqual([small])

    const user = SingleKey.fromPrivateKey(randomBytes(32))
    const script = new AtomicVtxoScript({
      funder: await signer.xOnlyPublicKey(),
      claimer: await user.xOnlyPublicKey(),
      server: await signer.serverXOnly(),
      paymentHash: randomBytes(32),
      refundLocktime: T,
      exitDelay: info.unilateralExitDelay,
    })
    const self = await signer.selfScript()
    const inputs: ArkTxInput[] = funding.map((f) => ({
      txid: f.txid,
      vout: f.vout,
      value: f.value,
      tapLeafScript: self.forfeit(),
      tapTree: self.encode(),
    }))
    const unroll = await signer.serverUnroll()
    const outpoint = await fundShared(inputs, [{ script: script.pkScript, amount: BigInt(small) }], unroll, signer.identity, signer.ark)

    const sharedPk = hex.encode(script.pkScript)
    const onShared = await waitFor('the shared vtxo', async () => {
      const { vtxos } = await signer.indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
      return vtxos.find((v) => v.txid === outpoint.txid)
    })
    expect(onShared.value).toBe(small)
    expect((await signer.ownVtxos()).map((v) => v.value)).toEqual([large])

    const shared: SharedVtxo = { txid: outpoint.txid, vout: outpoint.vout, value: small, script }
    const cancelTxid = await cancelSpend(shared, [{ script: self.pkScript, amount: BigInt(small) }], unroll, signer.identity, user, signer.ark)
    const back = await waitFor('the cancelled value back on our script', async () => {
      const v = await signer.ownVtxos()
      return v.find((x) => x.txid === cancelTxid)
    })
    expect(back.value).toBe(small)
    expect((await signer.ownVtxos()).map((v) => v.value).sort((a, b) => a - b)).toEqual([small, large])
  }, 180_000)
})
