import { VHTLC, type TapLeafScript } from '@arkade-os/sdk'
import { AtomicVtxoScript } from './script'

// One swap, two possible scripts (F32_VHTLC_PLAN.md §4): dust+ rides the SDK's
// VHTLC, sub-dust the 4-leaf AtomicVtxoScript. The swap flow only ever asks for
// a leaf by its ROLE, and the roles line up one to one:
//
//   role    who signs                    4-leaf    VHTLC
//   claim   claimer + server + preimage  claim     claim            (4-leaf also needs F's presig)
//   cancel  funder + claimer + server    cancel    refund
//   refund  funder + server, after T     refund    refundWithoutReceiver
//   uexit   funder alone, CSV            uexit     unilateralRefundWithoutReceiver
//   uclaim  claimer + preimage, CSV      —         unilateralClaim  (the leaf F32 was missing)

export type SwapScript = AtomicVtxoScript | VHTLC.Script

export interface RoleLeaves {
  claim: TapLeafScript
  cancel: TapLeafScript
  refund: TapLeafScript
  uexit: TapLeafScript
  /** Only the VHTLC has it. */
  uclaim?: TapLeafScript
}

export const isVhtlcScript = (s: SwapScript): s is VHTLC.Script => !(s instanceof AtomicVtxoScript)

export function roleLeaves(s: SwapScript): RoleLeaves {
  if (s instanceof AtomicVtxoScript) return { claim: s.claim(), cancel: s.cancel(), refund: s.refund(), uexit: s.uexit() }
  return {
    claim: s.claim(),
    cancel: s.refund(),
    refund: s.refundWithoutReceiver(),
    uexit: s.unilateralRefundWithoutReceiver(),
    uclaim: s.unilateralClaim(),
  }
}

/** The funder's x-only key (the VHTLC's sender). */
export const funderKey = (s: SwapScript): Uint8Array => (s instanceof AtomicVtxoScript ? s.options.funder : s.options.sender)

/** The claimer's x-only key (the VHTLC's receiver). */
export const claimerKey = (s: SwapScript): Uint8Array => (s instanceof AtomicVtxoScript ? s.options.claimer : s.options.receiver)
