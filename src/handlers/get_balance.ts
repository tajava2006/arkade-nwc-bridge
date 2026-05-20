import type { Wallet } from '@arkade-os/sdk'
import { satsToMsats } from '../lib/msat'

export interface GetBalanceDeps {
  wallet: Wallet
}

export async function handleGetBalance({ wallet }: GetBalanceDeps): Promise<{ balance: number }> {
  const balance = await wallet.getBalance()
  // NWC clients expect msat. `available` (settled + preconfirmed offchain)
  // is what we can spend through a submarine swap right now — boarding /
  // recoverable funds aren't directly usable.
  return { balance: satsToMsats(balance.available) }
}
