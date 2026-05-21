import type { Wallet } from '@arkade-os/sdk'
import { satsToMsats } from '../lib/msat'

export interface GetBalanceDeps {
  wallet: Wallet
}

export async function handleGetBalance({ wallet }: GetBalanceDeps): Promise<{ balance: number }> {
  const balance = await wallet.getBalance()
  // NWC clients expect msat. We report `available + recoverable` — the
  // recoverable bucket is mostly sub-dust VTXOs that are too small to be
  // worth a unilateral exit on their own, but they're still freely
  // spendable offchain (Ark merges them on send), so excluding them would
  // misrepresent how much the user can actually move. The arkade.money
  // wallet UI also collapses these two buckets in its main balance number.
  return { balance: satsToMsats(balance.available + balance.recoverable) }
}
