import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  SingleKey,
  Wallet,
} from '@arkade-os/sdk'
import type { Config } from './config'

export interface ArkContext {
  identity: SingleKey
  wallet: Wallet
  address: string
}

export async function initArkWallet(cfg: Config, privateKey: Uint8Array): Promise<ArkContext> {
  const identity = SingleKey.fromPrivateKey(privateKey)

  const wallet = await Wallet.create({
    identity,
    arkServerUrl: cfg.arkServerUrl,
    // Node has no IndexedDB; rebuild local caches from the indexer on each
    // boot. We have our own sqlite in src/db.ts for bridge-level state
    // (connections, payments, invoices) — that's a separate concern.
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
  })

  const address = await wallet.getAddress()
  return { identity, wallet, address }
}
