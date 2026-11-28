import { hex } from '@scure/base'
import {
  CSVMultisigTapscript,
  VtxoScript,
  type ConditionCSVMultisigTapscript,
} from '@arkade-os/sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { hashlockConditionScript } from '../atomic/script'

// CSV-satisfaction judgment for a fully-unrolled vtxo. The SDK has this
// logic inside prepareUnrollTransaction as a module-private helper
// (availableExitPath, ts-sdk src/wallet/unroll.ts) — replicated here because
// the engine needs it against vault-stored tapTrees with no Wallet object,
// and the UI (#13) needs the countdown numbers, not just the boolean.

export interface BlockTime {
  height: number
  time: number
}

export type ExitPath = CSVMultisigTapscript.Type | ConditionCSVMultisigTapscript.Type

export interface CsvPathStatus {
  type: 'blocks' | 'seconds'
  /** timelock size from the tapscript */
  need: number
  /** blocks/seconds elapsed since the vtxo tx confirmed */
  have: number
  satisfied: boolean
  path: ExitPath
}

/**
 * The exit paths WE can take: a plain CSV multisig over exactly our key. A
 * wallet coin has one (its own exit), an atomic shared vtxo one (`uexit`, the
 * funder's), but a swap lockup like a VHTLC has several CSV leaves — the
 * provider's claim (preimage + provider), a refund that still needs the
 * provider's signature, and the client-only `unilateralRefundWithoutReceiver`
 * — and only the last is ours to sign. Picking the first one whose timelock
 * elapsed would hand the sweep a leaf it cannot satisfy (found with a solver
 * lockup, SM-55; kept because any multi-leaf script can do it). Without `ourXOnly`, every exit path
 * (display / estimates that don't care whose it is).
 */
export function exitPathsFor(tapTreeHex: string, ourXOnly?: Uint8Array, preimage?: Uint8Array): ExitPath[] {
  const exits = VtxoScript.decode(hex.decode(tapTreeHex)).exitPaths()
  if (!ourXOnly) return exits
  const ours = hex.encode(ourXOnly)
  const alone = (p: ExitPath) => p.params.pubkeys.length === 1 && hex.encode(p.params.pubkeys[0]!) === ours
  // A receive VHTLC's unilateralClaim is ours too — but only with the preimage
  // its hashlock wants (F32_VHTLC_PLAN §7), which the swap row holds.
  const hashlock = preimage ? hex.encode(hashlockConditionScript(sha256(preimage))) : undefined
  return exits.filter((p) =>
    CSVMultisigTapscript.is(p)
      ? alone(p)
      : hashlock !== undefined && alone(p) && hex.encode((p as ConditionCSVMultisigTapscript.Type).params.conditionScript) === hashlock,
  )
}

export function csvPathStatuses(
  tapTreeHex: string,
  confirmedAt: BlockTime,
  tip: BlockTime,
  ourXOnly?: Uint8Array,
  preimage?: Uint8Array,
): CsvPathStatus[] {
  const exits = exitPathsFor(tapTreeHex, ourXOnly, preimage)
  return exits.map((path) => {
    const { type, value } = path.params.timelock
    const need = Number(value)
    const have =
      type === 'blocks' ? tip.height - confirmedAt.height : tip.time - confirmedAt.time
    return { type, need, have, satisfied: have >= need, path }
  })
}

/** First exit path whose timelock has elapsed — of the ones we can sign alone when `ourXOnly` is given. */
export function availableExitPath(
  tapTreeHex: string,
  confirmedAt: BlockTime,
  tip: BlockTime,
  ourXOnly?: Uint8Array,
  preimage?: Uint8Array,
): ExitPath | undefined {
  return csvPathStatuses(tapTreeHex, confirmedAt, tip, ourXOnly, preimage).find((s) => s.satisfied)?.path
}

/** The preimage of a receive swap whose VHTLC is this vault vtxo — what unlocks its claim leaf on chain. */
export function swapPreimageFor(db: import('bun:sqlite').Database, txid: string, vout: number): Uint8Array | undefined {
  const r = db
    .query<{ preimage: string }, [string]>(
      `SELECT preimage FROM atomic_swaps WHERE funding_outpoint = ? AND direction = 'receive' AND preimage IS NOT NULL`,
    )
    .get(`${txid}:${vout}`)
  return r ? hex.decode(r.preimage) : undefined
}
