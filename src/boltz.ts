import {
  ArkadeSwaps,
  type BoltzSwap,
  type SwapRepository,
} from '@arkade-os/boltz-swap'
import type { Wallet } from '@arkade-os/sdk'

// GetSwapsFilter is referenced by SwapRepository.getAllSwaps but not exported
// at the package root. Derive the same parameter shape from the interface
// itself so we don't depend on the unexported name.
type SwapsFilter = Parameters<SwapRepository['getAllSwaps']>[0]

/**
 * In-memory swap repository — placeholder for phase 4 boot validation.
 * @arkade-os/boltz-swap falls back to IndexedDB when no repository is given,
 * which doesn't exist in Node. A real sqlite-backed implementation lands in
 * phase 6 alongside the make_invoice / pay_invoice flows that actually need
 * to durably persist swap state across restarts.
 */
class InMemorySwapRepository implements SwapRepository {
  readonly version = 1
  private readonly swaps = new Map<string, BoltzSwap>()

  async saveSwap<T extends BoltzSwap>(swap: T): Promise<void> {
    this.swaps.set(swap.id, swap)
  }

  async deleteSwap(id: string): Promise<void> {
    this.swaps.delete(id)
  }

  async getAllSwaps<T extends BoltzSwap>(_filter?: SwapsFilter): Promise<T[]> {
    return Array.from(this.swaps.values()) as T[]
  }

  async clear(): Promise<void> {
    this.swaps.clear()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.swaps.clear()
  }
}

export interface BoltzContext {
  swaps: ArkadeSwaps
}

export async function initBoltz(wallet: Wallet): Promise<BoltzContext> {
  // No swapProvider — let ArkadeSwaps.create pick the SDK's built-in default
  // (api.boltz.exchange for bitcoin), which is the same endpoint the
  // arkade.money production wallet ships with and gives lower submarine fees
  // (0.1% vs 0.25%) than the ark-specific endpoint that the d.ts docstring
  // incorrectly claims is the default. If we ever need to point at a
  // different Boltz instance, add it back behind an opt-in env var.
  const swaps = await ArkadeSwaps.create({
    wallet,
    swapRepository: new InMemorySwapRepository(),
    // Background swap monitor disabled until phase 6 — we want explicit
    // control over when claim/refund workers start, and there are no
    // pending swaps to monitor yet anyway.
    swapManager: false,
  })
  return { swaps }
}
