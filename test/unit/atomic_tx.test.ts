import { beforeAll, describe, expect, test } from 'bun:test'
import { CSVMultisigTapscript, DefaultVtxo, SingleKey, type ArkAddress } from '@arkade-os/sdk'
import { AtomicVtxoScript } from '../../src/atomic/script'
import { computeClaimSplit, type AtomicOutput } from '../../src/atomic/split'
import {
  buildClaimPair,
  decodePsbt,
  encodePsbt,
  presignClaim,
  verifyPresig,
  type SharedVtxo,
} from '../../src/atomic/tx'

// Everything here is offline (buildOffchainTx + sign + verify are local); only
// submit/finalize need arkd, which the rewritten #01 spike covers on regtest.

const D = 512n
const DUST = 330
const server = SingleKey.fromPrivateKey(Uint8Array.from([...Array(31).fill(0), 3]))

let F: SingleKey
let C: SingleKey
let fXOnly: Uint8Array
let cXOnly: Uint8Array
let sXOnly: Uint8Array
let script: AtomicVtxoScript
let shared: SharedVtxo
let outputs: AtomicOutput[]
let unroll: CSVMultisigTapscript.Type

beforeAll(async () => {
  F = SingleKey.fromPrivateKey(Uint8Array.from([...Array(31).fill(0), 1]))
  C = SingleKey.fromPrivateKey(Uint8Array.from([...Array(31).fill(0), 2]))
  fXOnly = await F.xOnlyPublicKey()
  cXOnly = await C.xOnlyPublicKey()
  sXOnly = await server.xOnlyPublicKey()

  script = new AtomicVtxoScript({
    funder: fXOnly,
    claimer: cXOnly,
    server: sXOnly,
    paymentHash: new Uint8Array(32).fill(0xab),
    refundLocktime: 1893456000n,
    exitDelay: D,
  })
  shared = { txid: 'ab'.repeat(32), vout: 0, value: 1000, script }

  const defaultAddr = (xonly: Uint8Array): ArkAddress =>
    new DefaultVtxo.Script({ pubKey: xonly, serverPubKey: sXOnly, csvTimelock: { type: 'seconds', value: D } }).address(
      'tark',
      sXOnly,
    )
  outputs = computeClaimSplit({
    funderAddress: defaultAddr(fXOnly),
    claimerAddress: defaultAddr(cXOnly),
    fundingValue: 1000,
    amount: 21,
    dust: DUST,
  }).outputs

  unroll = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: D }, pubkeys: [sXOnly] })
})

describe('wire format', () => {
  test('encodePsbt/decodePsbt round-trips a claim pair', () => {
    const { arkTx } = buildClaimPair(shared, outputs, unroll)
    expect(decodePsbt(encodePsbt(arkTx)).id).toBe(arkTx.id)
  })
})

describe('buildClaimPair determinism', () => {
  test('same (input, outputs, unroll) → identical txids', () => {
    const a = buildClaimPair(shared, outputs, unroll)
    const b = buildClaimPair(shared, outputs, unroll)
    expect(a.arkTx.id).toBe(b.arkTx.id)
    expect(a.checkpoint.id).toBe(b.checkpoint.id)
  })
})

describe('presign + verify-before-act', () => {
  test('a valid F presig verifies against the deterministic rebuild', async () => {
    const presig = await presignClaim(shared, outputs, unroll, F)
    const v = verifyPresig(shared, outputs, unroll, presig, fXOnly)
    expect(v.arkTx.id).toBe(decodePsbt(presig.arkTx).id)
    expect(v.checkpoint.id).toBe(decodePsbt(presig.checkpoint).id)
  })

  test('rejects a presig for the wrong funder key', async () => {
    const presig = await presignClaim(shared, outputs, unroll, F)
    expect(() => verifyPresig(shared, outputs, unroll, presig, cXOnly)).toThrow(/does not verify/)
  })

  test('rejects a presig signed by C (not the funder)', async () => {
    const notFunder = await presignClaim(shared, outputs, unroll, C)
    expect(() => verifyPresig(shared, outputs, unroll, notFunder, fXOnly)).toThrow(/does not verify/)
  })

  test('rejects when the claimer rebuilds a DIFFERENT split (F signed another tx)', async () => {
    const presig = await presignClaim(shared, outputs, unroll, F)
    // C tries to verify against tampered outputs (e.g. a larger a to itself).
    const tampered = computeClaimSplit({
      funderAddress: new DefaultVtxo.Script({ pubKey: fXOnly, serverPubKey: sXOnly, csvTimelock: { type: 'seconds', value: D } }).address('tark', sXOnly),
      claimerAddress: new DefaultVtxo.Script({ pubKey: cXOnly, serverPubKey: sXOnly, csvTimelock: { type: 'seconds', value: D } }).address('tark', sXOnly),
      fundingValue: 1000,
      amount: 300, // different a → different arkTx → txid mismatch
      dust: DUST,
    }).outputs
    expect(() => verifyPresig(shared, tampered, unroll, presig, fXOnly)).toThrow(/txid mismatch/)
  })
})
