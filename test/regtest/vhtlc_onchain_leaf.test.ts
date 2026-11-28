import '../../src/polyfills'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { hex } from '@scure/base'
import { Address, OutScript } from '@scure/btc-signer'
import { SingleKey, timelockToSequence } from '@arkade-os/sdk'
import { buildVhtlc, signLeafSpend, signLeafSpendAtRate, roleLeaves } from '../../src/atomic'
import { BitcoindOnchainProvider, BitcoindRpc } from '../../src/chain/bitcoind'
import { findSpender } from '../../src/chain/spender'

// The VHTLC's two on-chain leaves under real consensus rules. An unrolled
// VHTLC is just a taproot output carrying the VHTLC's script, so a plain
// onchain payment to that script is the same thing without the Ark unroll in
// front: what's proven here is the leaf spend itself — CSV, signature, and the
// hand-laid condition witness. Delays are tiny (onchain-only; arkd never sees
// this script) and the clock moves with setmocktime, ~20 minutes, then back.
//
//   eval "$(test-script/regtest-solver.sh env)" && bun test test/regtest/vhtlc_onchain_leaf.test.ts

const BITCOIND = process.env.REGTEST_BITCOIND_URL ?? 'http://localhost:18443'
const RUN = !!process.env.SUBDUSTD_URL

const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef }
const sha256 = (b: Uint8Array) => Uint8Array.from(createHash('sha256').update(b).digest())

describe.skipIf(!RUN)('VHTLC on-chain leaves on regtest', () => {
  const rpc = new BitcoindRpc({ url: BITCOIND, user: 'admin1', password: '123' })
  const wallet = new BitcoindRpc({ url: `${BITCOIND}/wallet/default`, user: 'admin1', password: '123' })
  const chain = new BitcoindOnchainProvider(rpc)
  const sender = SingleKey.fromPrivateKey(randomBytes(32))
  const receiver = SingleKey.fromPrivateKey(randomBytes(32))
  const server = SingleKey.fromPrivateKey(randomBytes(32))
  const preimage = Uint8Array.from(randomBytes(32))
  let script: ReturnType<typeof buildVhtlc>
  let fundedClaim: { txid: string; vout: number; value: number }
  let fundedRefund: { txid: string; vout: number; value: number }
  let fundedHeight: number
  let mine: (n: number) => Promise<void>

  /** Pay `sats` to the VHTLC's own script, as an unroll would leave it. */
  const fund = async (sats: number) => {
    const addr = Address(REGTEST).encode(OutScript.decode(script.pkScript))
    const txid = await wallet.call<string>('sendtoaddress', [addr, sats / 1e8])
    const tx = await rpc.call<{ vout: { n: number; scriptPubKey: { hex: string } }[] }>('getrawtransaction', [txid, true])
    const vout = tx.vout.find((o) => o.scriptPubKey.hex === hex.encode(script.pkScript))!.n
    return { txid, vout, value: sats }
  }
  const dest = async () => OutScript.encode(Address(REGTEST).decode(await wallet.call<string>('getnewaddress', ['', 'bech32m'])))
  const accept = async (rawHex: string) =>
    (await rpc.call<{ allowed: boolean; 'reject-reason'?: string }[]>('testmempoolaccept', [[rawHex]]))[0]!

  beforeAll(async () => {
    script = buildVhtlc({
      sender: await sender.xOnlyPublicKey(),
      receiver: await receiver.xOnlyPublicKey(),
      server: await server.xOnlyPublicKey(),
      paymentHash: sha256(preimage),
      timeouts: { refundLocktime: Math.floor(Date.now() / 1000) + 100_000, claimDelaySecs: 512, refundDelaySecs: 1024, refundNoReceiverDelaySecs: 1024 },
    })
    const miner = await wallet.call<string>('getnewaddress', [])
    mine = async (n) => void (await rpc.call('generatetoaddress', [n, miner]))
    fundedClaim = await fund(100_000)
    fundedRefund = await fund(100_000)
    await mine(1)
    fundedHeight = (await rpc.call<{ blocks: number }>('getblockchaininfo')).blocks
  }, 60_000)

  afterAll(async () => {
    await rpc.call('setmocktime', [0]).catch(() => {})
  })

  test('before d_c: the claim leaf is not yet final (BIP-68)', async () => {
    const leaves = roleLeaves(script)
    const tx = await signLeafSpend(
      { ...fundedClaim, pkScript: script.pkScript, leaf: leaves.uclaim!, sequence: timelockToSequence({ type: 'seconds', value: 512n }), preimage, destination: await dest(), feeSats: 500 },
      receiver,
    )
    expect((await accept(tx.hex))['reject-reason']).toBe('non-BIP68-final')
  }, 60_000)

  test('after the CSVs: the receiver claims with the preimage, a wrong preimage is rejected, the sender takes the other output alone', async () => {
    const now = Math.floor(Date.now() / 1000)
    await rpc.call('setmocktime', [now + 1_300])
    await mine(12) // MTP is the median of 11 blocks — it now sits past d_s from the funding block
    const leaves = roleLeaves(script)
    const claimArgs = {
      ...fundedClaim,
      pkScript: script.pkScript,
      leaf: leaves.uclaim!,
      sequence: timelockToSequence({ type: 'seconds', value: 512n }),
      destination: await dest(),
    }

    const wrong = await signLeafSpend({ ...claimArgs, preimage: Uint8Array.from(randomBytes(32)), feeSats: 500 }, receiver)
    expect((await accept(wrong.hex)).allowed).toBe(false)
    // and the sender can't use the receiver's leaf
    const thief = await signLeafSpend({ ...claimArgs, preimage, feeSats: 500 }, sender).catch((e: Error) => e)
    expect(thief).toBeInstanceOf(Error)

    const claim = await signLeafSpendAtRate({ ...claimArgs, preimage }, 2, receiver)
    expect((await accept(claim.hex)).allowed).toBe(true)
    await chain.broadcastTransaction(claim.hex)

    const refund = await signLeafSpendAtRate(
      { ...fundedRefund, pkScript: script.pkScript, leaf: leaves.uexit, sequence: timelockToSequence({ type: 'seconds', value: 1024n }), destination: await dest() },
      2,
      sender,
    )
    await chain.broadcastTransaction(refund.hex)
    await mine(1)
    expect((await chain.getTxStatus(claim.id)).confirmed).toBe(true)
    expect((await chain.getTxStatus(refund.id)).confirmed).toBe(true)

    // How subdustd learns a preimage revealed on chain: the claim input's witness carries it second.
    const spender = await findSpender(chain, fundedClaim.txid, fundedClaim.vout, fundedHeight)
    expect(spender?.txid).toBe(claim.id)
    expect(hex.encode(spender!.witness[1]!)).toBe(hex.encode(preimage))
    expect(hex.encode(sha256(spender!.witness[1]!))).toBe(hex.encode(sha256(preimage)))
  }, 120_000)
})
