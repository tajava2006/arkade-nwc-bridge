import { describe, expect, test } from 'bun:test'
import { hex } from '@scure/base'
import { CSVMultisigTapscript, DefaultVtxo, VHTLC } from '@arkade-os/sdk'
import { availableExitPath, csvPathStatuses, exitPathsFor } from '../../src/exit/csv'
import { AtomicVtxoScript } from '../../src/atomic'

// SM-55: the exit engine must sweep through a leaf it can sign ALONE. A solver
// lockup (VHTLC) carries three CSV leaves — the solver's claim (preimage +
// solver), a refund that still needs the solver, and the client-only
// unilateralRefundWithoutReceiver — and the sweep signs with our key only.

const key = (b: number) => new Uint8Array(32).fill(b)
const OURS = key(0x11)
const SOLVER = key(0x22)
const SERVER = key(0x33)
const secs = (value: number) => ({ type: 'seconds' as const, value: BigInt(value) })

// The solver's claim matures first, the refund that needs the solver next,
// ours last — the order that broke "first matured leaf".
const lockup = new VHTLC.Script({
  sender: OURS,
  receiver: SOLVER,
  server: SERVER,
  preimageHash: new Uint8Array(20).fill(7),
  refundLocktime: 1_800_000_000n,
  unilateralClaimDelay: secs(1024),
  unilateralRefundDelay: secs(1536),
  unilateralRefundWithoutReceiverDelay: secs(2048),
})
const tapTree = hex.encode(lockup.encode())
const at = (t: number) => ({ height: 0, time: t })

describe('exit paths we can sign alone (SM-55)', () => {
  test('a solver lockup has three CSV leaves; only the client-only one is ours', () => {
    expect(exitPathsFor(tapTree)).toHaveLength(3)
    const ours = exitPathsFor(tapTree, OURS)
    expect(ours).toHaveLength(1)
    expect(CSVMultisigTapscript.is(ours[0]!)).toBe(true)
    expect(ours[0]!.params.pubkeys.map((p) => hex.encode(p))).toEqual([hex.encode(OURS)])
    expect(ours[0]!.params.timelock.value).toBe(2048n)
  })

  test("once only the solver's leaves have matured, nothing is ours to sweep yet", () => {
    // without our key the engine would have picked one of the solver's leaves here
    const anyone = availableExitPath(tapTree, at(0), at(1600))!
    const signableByUsAlone =
      CSVMultisigTapscript.is(anyone) && anyone.params.pubkeys.length === 1 && hex.encode(anyone.params.pubkeys[0]!) === hex.encode(OURS)
    expect(signableByUsAlone).toBe(false)
    expect(availableExitPath(tapTree, at(0), at(1600), OURS)).toBeUndefined()
  })

  test('after our own delay the sweep gets the client-only leaf', () => {
    const p = availableExitPath(tapTree, at(0), at(2100), OURS)!
    expect(p.params.pubkeys.map((k) => hex.encode(k))).toEqual([hex.encode(OURS)])
    expect(csvPathStatuses(tapTree, at(0), at(1000), OURS)[0]).toMatchObject({ need: 2048, have: 1000, satisfied: false })
  })

  test('a wallet coin and an atomic shared vtxo keep working: their one exit leaf is ours', () => {
    const wallet = new DefaultVtxo.Script({ pubKey: OURS, serverPubKey: SERVER, csvTimelock: secs(512) })
    expect(exitPathsFor(hex.encode(wallet.encode()), OURS)).toHaveLength(1)
    const shared = new AtomicVtxoScript({
      funder: OURS,
      claimer: SOLVER,
      server: SERVER,
      paymentHash: new Uint8Array(32).fill(9),
      refundLocktime: 1_800_000_000n,
      exitDelay: 512n,
    })
    expect(exitPathsFor(hex.encode(shared.encode()), OURS)).toHaveLength(1)
    // ...and as the claimer of a receive, the shared vtxo has no exit leaf of ours at all
    expect(exitPathsFor(hex.encode(shared.encode()), SOLVER)).toHaveLength(0)
  })
})
