import { createHash } from 'node:crypto'
import { hex } from '@scure/base'
import { Script } from '@scure/btc-signer'
import {
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  ConditionMultisigTapscript,
  MultisigTapscript,
  VtxoScript,
  type TapLeafScript,
} from '@arkade-os/sdk'

// The atomic sub-dust shared script (ATOMIC_SUBDUST_PLAN.md §3.1). A single
// funder F locks a regular vtxo V behind four leaves; the payment amount a is
// folded into a pre-signed claim split, never into the shared output itself.
// Proven end-to-end on regtest in spike #01 (claim/refund/cancel) and #02
// (F unilateral exit) — this module is the production formalization of that
// exact encoding, so the leaf bytes MUST stay byte-identical (regression
// fixtures in test/unit/atomic_script.test.ts guard it).
//
//   1 claim  : ConditionMultisig{ HASH160 ripemd160(H) EQUAL, [F, C, server] }
//   2 refund : CLTVMultisig{ T, [F, server] }
//   3 cancel : Multisig{ [F, C, server] }
//   4 uexit  : CSVMultisig{ d, [F] }

/** RIPEMD-160 via Node crypto (matches the bridge's node-crypto hashing style). */
export function ripemd160(data: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('ripemd160').update(data).digest())
}

/**
 * The hashlock condition for the claim leaf: `OP_HASH160 <ripemd160(H)> OP_EQUAL`.
 * Commits HASH160(preimage) = ripemd160(sha256(preimage)) = ripemd160(H) and is
 * satisfied by revealing the raw preimage in the witness — identical to the
 * production VHTLC preimage condition, so the same LN preimage settles both.
 *
 * @param paymentHash H = sha256(preimage), the 32-byte BOLT11 payment hash.
 */
export function hashlockConditionScript(paymentHash: Uint8Array): Uint8Array {
  if (paymentHash.length !== 32) {
    throw new Error(`paymentHash (H = sha256(preimage)) must be 32 bytes, got ${paymentHash.length}`)
  }
  return Script.encode(['HASH160', ripemd160(paymentHash), 'EQUAL'])
}

/** x-only (32-byte) participant keys for the shared script. */
export interface AtomicScriptKeys {
  funder: Uint8Array
  claimer: Uint8Array
  server: Uint8Array
}

export interface AtomicScriptOptions extends AtomicScriptKeys {
  /** H = sha256(preimage), the BOLT11 payment hash (32 bytes). */
  paymentHash: Uint8Array
  /** T — absolute CLTV locktime for the refund leaf (seconds, BIP65 ≥ 5e8). */
  refundLocktime: bigint
  /** d — CSV delay for the uexit leaf; the server's unilateralExitDelay as-is. */
  exitDelay: bigint
}

// arkd reads timelock UNITS by magnitude (≥512 = seconds, <512 = blocks). Both
// modes are supported so the same builder works on mainnet (seconds) and the
// block-mode regtest drills.
function timelockType(value: bigint): 'seconds' | 'blocks' {
  return value >= 512n ? 'seconds' : 'blocks'
}

function assertXOnly(key: Uint8Array, name: string): void {
  if (key.length !== 32) throw new Error(`${name} must be a 32-byte x-only pubkey, got ${key.length}`)
}

/**
 * The 4-leaf shared VtxoScript. Only `claim` is multi-party (F+C+server) —
 * the split amount's sole enforcement is F's pre-signature on the claim pair
 * (#05). `refund`/`cancel`/`uexit` each pay one party in full, so none needs a
 * pre-signature: F reclaims via `refund` after T or `uexit` after unilateral
 * exit; `cancel` is a live F+C+server unwind.
 */
export class AtomicVtxoScript extends VtxoScript {
  readonly claimLeafHex: string
  readonly refundLeafHex: string
  readonly cancelLeafHex: string
  readonly uexitLeafHex: string

  constructor(readonly options: AtomicScriptOptions) {
    const { funder, claimer, server, paymentHash, refundLocktime, exitDelay } = options
    assertXOnly(funder, 'funder')
    assertXOnly(claimer, 'claimer')
    assertXOnly(server, 'server')
    if (refundLocktime <= 0n) throw new Error('refundLocktime (T) must be > 0')
    if (exitDelay <= 0n) throw new Error('exitDelay (d) must be > 0')

    const claim = ConditionMultisigTapscript.encode({
      conditionScript: hashlockConditionScript(paymentHash),
      pubkeys: [funder, claimer, server],
    }).script
    const refund = CLTVMultisigTapscript.encode({
      absoluteTimelock: refundLocktime,
      pubkeys: [funder, server],
    }).script
    const cancel = MultisigTapscript.encode({
      pubkeys: [funder, claimer, server],
    }).script
    const uexit = CSVMultisigTapscript.encode({
      timelock: { type: timelockType(exitDelay), value: exitDelay },
      pubkeys: [funder],
    }).script

    super([claim, refund, cancel, uexit])
    this.claimLeafHex = hex.encode(claim)
    this.refundLeafHex = hex.encode(refund)
    this.cancelLeafHex = hex.encode(cancel)
    this.uexitLeafHex = hex.encode(uexit)
  }

  /** Collaborative claim leaf (F+C+server + preimage). Pre-signed by F. */
  claim(): TapLeafScript {
    return this.findLeaf(this.claimLeafHex)
  }
  /** CLTV refund leaf (F+server after T). */
  refund(): TapLeafScript {
    return this.findLeaf(this.refundLeafHex)
  }
  /** Cooperative cancel leaf (F+C+server, no timelock). */
  cancel(): TapLeafScript {
    return this.findLeaf(this.cancelLeafHex)
  }
  /** Unilateral exit leaf (CSV d, F only). Swept after unroll (#02). */
  uexit(): TapLeafScript {
    return this.findLeaf(this.uexitLeafHex)
  }
}
