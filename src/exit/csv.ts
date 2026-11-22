import { hex } from '@scure/base'
import {
  CSVMultisigTapscript,
  VtxoScript,
  type ConditionCSVMultisigTapscript,
} from '@arkade-os/sdk'

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
 * funder's), but a solver lockup (VHTLC) has three CSV leaves — the solver's
 * claim (preimage + solver), a refund that still needs the solver's signature,
 * and the client-only `unilateralRefundWithoutReceiver` — and only the last is
 * ours to sign. Picking the first one whose timelock elapsed would hand the
 * sweep a leaf it cannot satisfy (SM-55). Without `ourXOnly`, every exit path
 * (display / estimates that don't care whose it is).
 */
export function exitPathsFor(tapTreeHex: string, ourXOnly?: Uint8Array): ExitPath[] {
  const exits = VtxoScript.decode(hex.decode(tapTreeHex)).exitPaths()
  if (!ourXOnly) return exits
  const ours = hex.encode(ourXOnly)
  return exits.filter(
    (p) => CSVMultisigTapscript.is(p) && p.params.pubkeys.length === 1 && hex.encode(p.params.pubkeys[0]!) === ours,
  )
}

export function csvPathStatuses(
  tapTreeHex: string,
  confirmedAt: BlockTime,
  tip: BlockTime,
  ourXOnly?: Uint8Array,
): CsvPathStatus[] {
  const exits = exitPathsFor(tapTreeHex, ourXOnly)
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
): ExitPath | undefined {
  return csvPathStatuses(tapTreeHex, confirmedAt, tip, ourXOnly).find((s) => s.satisfied)?.path
}
