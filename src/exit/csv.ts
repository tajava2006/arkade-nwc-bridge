import { hex } from '@scure/base'
import {
  VtxoScript,
  type CSVMultisigTapscript,
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

export function csvPathStatuses(
  tapTreeHex: string,
  confirmedAt: BlockTime,
  tip: BlockTime,
): CsvPathStatus[] {
  const exits = VtxoScript.decode(hex.decode(tapTreeHex)).exitPaths()
  return exits.map((path) => {
    const { type, value } = path.params.timelock
    const need = Number(value)
    const have =
      type === 'blocks' ? tip.height - confirmedAt.height : tip.time - confirmedAt.time
    return { type, need, have, satisfied: have >= need, path }
  })
}

/** First exit path whose timelock has elapsed — mirrors the SDK's availableExitPath. */
export function availableExitPath(
  tapTreeHex: string,
  confirmedAt: BlockTime,
  tip: BlockTime,
): ExitPath | undefined {
  return csvPathStatuses(tapTreeHex, confirmedAt, tip).find((s) => s.satisfied)?.path
}
