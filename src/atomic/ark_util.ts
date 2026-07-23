import type { RestIndexerProvider } from '@arkade-os/sdk'

// Small ARK helpers shared by the atomic send/receive orchestration
// (send.ts / receive.ts). Bridge-only (NOT vendored to boltz) — the vendored
// pure lib keeps its own module-private copies on purpose (dependency
// isolation); this just stops the two orchestration flows from each redefining
// the same three one-liners + the identical spent-poll.

/** Drop the parity byte if a 33-byte compressed key slipped in. */
export const toXOnly = (k: Uint8Array): Uint8Array => (k.length === 32 ? k : k.subarray(1))

/** arkd reads timelock units by magnitude (≥512 = seconds, else blocks). */
export const timelockType = (v: bigint): 'seconds' | 'blocks' => (v >= 512n ? 'seconds' : 'blocks')

/** ARK address human-readable prefix for the network. */
export const hrp = (network: string): string => (network === 'bitcoin' ? 'ark' : 'tark')

/**
 * Has `txid:vout` been spent per the indexer? Short poll (6×1s) to tolerate
 * indexer lag. Conservative: an ambiguous/absent read returns false, so the
 * caller keeps the swap recoverable (verify-before-bookkeep, F4/F18).
 */
export async function confirmSpent(
  indexer: RestIndexerProvider,
  txid: string,
  vout: number,
): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    try {
      const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid, vout }] })
      if (vtxos.find((v) => v.txid === txid && v.vout === vout)?.spentBy) return true
    } catch {
      // transient indexer error — retry
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}
