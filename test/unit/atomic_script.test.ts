import { describe, expect, test } from 'bun:test'
import { hex } from '@scure/base'
import {
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  ConditionMultisigTapscript,
  MultisigTapscript,
  VtxoScript,
} from '@arkade-os/sdk'
import { AtomicVtxoScript, hashlockConditionScript, ripemd160 } from '../../src/atomic/script'

// Fixed vectors: F/C/S are the secp256k1 generator's 1×/2×/3× x-only keys
// (privkeys 1,2,3) — deterministic and valid on-curve so VtxoScript accepts
// them. H = 0xab×32, T = 1893456000 (2030-01-01Z), d = 512s.
const F = hex.decode('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
const C = hex.decode('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5')
const S = hex.decode('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9')
const H = new Uint8Array(32).fill(0xab)
const T = 1893456000n
const D = 512n

// Regression fixtures — these exact leaf bytes were ACCEPTED by arkd in spikes
// #01 (claim/refund/cancel) and #02 (uexit sweep). Any drift here means the
// production encoding diverged from what arkd validated; treat as a red flag.
const CLAIM =
  'a9145786aabcae0e6cd2dfaeca2767dc8996c98f43f487692079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ad20c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5ad20f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9ac'
const REFUND =
  '0480d8db70b1752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ad20f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9ac'
const CANCEL =
  '2079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ad20c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5ad20f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9ac'
const UEXIT = '03010040b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac'

function build(overrides: Partial<ConstructorParameters<typeof AtomicVtxoScript>[0]> = {}) {
  return new AtomicVtxoScript({
    funder: F,
    claimer: C,
    server: S,
    paymentHash: H,
    refundLocktime: T,
    exitDelay: D,
    ...overrides,
  })
}

describe('AtomicVtxoScript encoding (arkd-accepted regression fixtures)', () => {
  const s = build()

  test('the four leaves match the byte-exact fixtures accepted by arkd in #01/#02', () => {
    expect(s.claimLeafHex).toBe(CLAIM)
    expect(s.refundLeafHex).toBe(REFUND)
    expect(s.cancelLeafHex).toBe(CANCEL)
    expect(s.uexitLeafHex).toBe(UEXIT)
  })

  test('claim leaf decodes as ConditionMultisig[F,C,server] with the hashlock', () => {
    const dec = ConditionMultisigTapscript.decode(hex.decode(s.claimLeafHex))
    expect(dec.params.pubkeys.map(hex.encode)).toEqual([F, C, S].map(hex.encode))
    expect(hex.encode(dec.params.conditionScript)).toBe(hex.encode(hashlockConditionScript(H)))
  })

  test('refund leaf decodes as CLTV(T)[F,server]', () => {
    const dec = CLTVMultisigTapscript.decode(hex.decode(s.refundLeafHex))
    expect(dec.params.absoluteTimelock).toBe(T)
    expect(dec.params.pubkeys.map(hex.encode)).toEqual([F, S].map(hex.encode))
  })

  test('cancel leaf decodes as Multisig[F,C,server]', () => {
    const dec = MultisigTapscript.decode(hex.decode(s.cancelLeafHex))
    expect(dec.params.pubkeys.map(hex.encode)).toEqual([F, C, S].map(hex.encode))
  })

  test('uexit leaf decodes as CSV(d seconds)[F]', () => {
    const dec = CSVMultisigTapscript.decode(hex.decode(s.uexitLeafHex))
    expect(dec.params.timelock).toEqual({ type: 'seconds', value: 512n })
    expect(dec.params.pubkeys.map(hex.encode)).toEqual([F].map(hex.encode))
  })

  test('leaf accessors resolve to the matching tapleaf scripts', () => {
    for (const [leaf, expected] of [
      [s.claim(), CLAIM],
      [s.refund(), REFUND],
      [s.cancel(), CANCEL],
      [s.uexit(), UEXIT],
    ] as const) {
      // TapLeafScript[1] is the script + trailing leaf-version byte.
      expect(hex.encode(leaf[1].subarray(0, leaf[1].length - 1))).toBe(expected)
    }
  })
})

describe('AtomicVtxoScript timelock units + validation', () => {
  test('block-mode exit delay (<512) encodes as a blocks CSV', () => {
    const s = build({ exitDelay: 20n })
    const dec = CSVMultisigTapscript.decode(hex.decode(s.uexitLeafHex))
    expect(dec.params.timelock).toEqual({ type: 'blocks', value: 20n })
  })

  test('rejects non-32-byte keys, bad payment hash, and non-positive timelocks', () => {
    expect(() => build({ funder: new Uint8Array(31) })).toThrow(/funder/)
    expect(() => build({ paymentHash: new Uint8Array(20) })).toThrow(/32 bytes/)
    expect(() => build({ refundLocktime: 0n })).toThrow(/refundLocktime/)
    expect(() => build({ exitDelay: 0n })).toThrow(/exitDelay/)
  })

  test('hashlock condition commits ripemd160(H) with HASH160 … EQUAL framing', () => {
    const cond = hashlockConditionScript(H)
    expect(hex.encode(cond)).toBe(`a914${hex.encode(ripemd160(H))}87`)
  })
})

describe('exit-engine compatibility (#13)', () => {
  // The vault sweep derives spend paths generically via
  // VtxoScript.decode(tapTree).exitPaths(); on SDK 0.4.43 that returns
  // exactly our uexit leaf (the claim leaf trips the ConditionCSV decoder,
  // but per-leaf try/catch swallows it — debug noise only). Measured
  // 2026-07-16 (plan §8); this pins the behavior so an SDK bump that starts
  // throwing (or hides the leaf) breaks loudly here instead of at exit time.
  test('exitPaths() on the decoded 4-leaf tapTree yields exactly the uexit leaf', () => {
    const decoded = VtxoScript.decode(build().encode())
    const paths = decoded.exitPaths()
    expect(paths.length).toBe(1)
    expect(hex.encode(paths[0]!.script)).toBe(UEXIT)
    expect(paths[0]!.params.timelock).toEqual({ type: 'seconds', value: 512n })
  })
})
