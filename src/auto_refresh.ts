import { canSpendOffchain, isSubdust, isVtxoExpiringSoon, type ExtendedVirtualCoin } from '@arkade-os/sdk'

// Consolidate-all auto-refresh. The SDK's own renewal (settlementConfig in
// wallet.ts) folds only what is near expiry plus sub-dust/swept riders —
// VTXOs with time left stay fragmented. Policy here is the wholesale-refresh
// win-win instead (SEND_DESIGN.md §8): a round's onchain fee doesn't scale
// with VTXO count, so once ANY dust+ VTXO nears expiry, run the same
// no-args wallet.settle() the manual Refresh button uses and fold
// EVERYTHING into one fresh VTXO — fewer rounds for the server, one
// defragmented VTXO and a full expiry reset for the wallet.
//
// THE renewal knob. 4.75 days is not arbitrary — it is pinned by two neighbors:
//  - arkd's SETTLEMENT_MIN_EXPIRY_GAP (same 4.75d): a settle attempted earlier
//    than this is deferred, so a larger window would just spam rejected intents;
//  - the dust+ send gate. A VHTLC funding VTXO must outlive the swap's T by an
//    unroll + its confirmation (+ MTP lag) — sendFundingMinLifeSecs: 4.40d at
//    subdustd's 90h cap, 4.65d at the 96h we'd accept. Refreshing at 4.75d
//    keeps every VTXO above that with hours to spare (the 10-min poll and the
//    round itself eat a little of it), so no invoice — however long its route —
//    can land in a window where nothing may fund it (tested below the knob).
//    History: 3d with a 72h cap until 2026-10 (invoices behind an LSP measured
//    435 blocks against a 431 budget and failed NO_ROUTE), then 4d with 90h and
//    the 4-leaf script's T + 10 min, then 4.75d for the VHTLC (F32, 2026-11).
// Move all three together (operator workspace SETTINGS.md §1 / §7).
// Must stay well below the tree expiry (~31.7d) — a window ≥ the
// VTXO lifetime means every fresh VTXO is instantly "expiring" and rounds
// loop forever; the wiring's post-success cooldown bounds that failure mode
// but does not make it sane. The SDK renewal (wallet.ts, fixed 1h) stays on
// as the backstop and is deliberately NOT scaled with this knob — see there.
export const AUTO_REFRESH_THRESHOLD_SECONDS = 410_400

/**
 * True when some VTXO that can anchor a settlement round — spendable, dust+,
 * not swept — is within `thresholdMs` of its batch expiry. Sub-dust and
 * swept VTXOs never trigger on their own: post-anchor-rule arkd refuses
 * rounds anchored only by them (SUBDUST_GRIEFING.md), so a settle attempt
 * would just be deferred; they are recovered as riders when a real anchor
 * nears expiry (or via manual offboard).
 */
export function needsRefresh(
  vtxos: ExtendedVirtualCoin[],
  dust: bigint,
  thresholdMs: number,
): boolean {
  // SDK 0.5 port (money path — what triggers a refresh): 0.4's
  // isSpendable && !isRecoverable became canSpendOffchain, which also drops a
  // vtxo already past expiry but not yet swept. Such a coin is recoverable-only
  // and, like a swept one, cannot anchor a round on its own (anchor rule above),
  // so it was never a useful trigger.
  const now = { timestamp: new Date() }
  return vtxos.some(
    (v) => canSpendOffchain(v, now) && !isSubdust(v, dust) && isVtxoExpiringSoon(v, thresholdMs),
  )
}

export interface AutoRefreshDeps {
  /** wallet.getVtxos({ withRecoverable: true }) */
  getVtxos(): Promise<ExtendedVirtualCoin[]>
  /** arkInfo.dust (network read is fine — the pass is minutes apart) */
  getDust(): Promise<bigint>
  /** wallet.settle() with no args — the manual button's consolidate-all */
  settle(): Promise<string>
  /** cache refresh hook, called after a successful settle */
  onSettled?(txid: string): void
  log?(msg: string): void
}

/**
 * One pass: check expiry, consolidate if warranted. 'failed' asks the caller
 * to back off (a deferred/rejected intent would otherwise retry every tick);
 * a read failure before any settle attempt is 'idle' — nothing was risked,
 * the next tick just looks again.
 */
export async function autoRefreshPass(
  deps: AutoRefreshDeps,
  thresholdMs = AUTO_REFRESH_THRESHOLD_SECONDS * 1000,
): Promise<'idle' | 'refreshed' | 'failed'> {
  let vtxos: ExtendedVirtualCoin[]
  let dust: bigint
  try {
    ;[vtxos, dust] = await Promise.all([deps.getVtxos(), deps.getDust()])
  } catch (err) {
    deps.log?.(`auto-refresh: read failed (retrying next pass): ${err instanceof Error ? err.message : err}`)
    return 'idle'
  }
  if (!needsRefresh(vtxos, dust, thresholdMs)) return 'idle'

  deps.log?.(
    `auto-refresh: a VTXO is within ${Math.round(thresholdMs / 60_000)} min of expiry — consolidating all ${vtxos.length} VTXO(s)`,
  )
  try {
    const txid = await deps.settle()
    deps.log?.(`auto-refresh: consolidated — arkTxid ${txid}`)
    deps.onSettled?.(txid)
    return 'refreshed'
  } catch (err) {
    deps.log?.(`auto-refresh: settle failed: ${err instanceof Error ? err.message : err}`)
    return 'failed'
  }
}
