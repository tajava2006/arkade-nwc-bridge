import { ArkadeSwaps } from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'
import type { Database } from 'bun:sqlite'
import { SqliteSwapRepository } from './boltz_repository'

export interface BoltzContext {
  swaps: ArkadeSwaps
}

export async function initBoltz(deps: {
  db: Database
  wallet: Wallet
}): Promise<BoltzContext> {
  // No swapProvider — let ArkadeSwaps.create pick the SDK's built-in default
  // (api.boltz.exchange for bitcoin), which is the same endpoint the
  // arkade.money production wallet ships with and gives lower submarine fees
  // (0.1% vs 0.25%) than the ark-specific endpoint that the d.ts docstring
  // incorrectly claims is the default. If we ever need to point at a
  // different Boltz instance, add it back behind an opt-in env var.
  const swaps = await ArkadeSwaps.create({
    wallet: deps.wallet,
    swapRepository: new SqliteSwapRepository(deps.db),
    // Background swap monitor: handles auto-claim of reverse swap VHTLCs and
    // auto-refund of submarine swaps that fail on the Lightning side. Also
    // resumes pending swaps from the repository on boot — so if the bridge
    // restarts mid-flight, the manager picks up the pieces. See chunk-B3Q4TFWT.js
    // around the autoActions loop for the exact resume behavior.
    swapManager: true,
  })
  return { swaps }
}
