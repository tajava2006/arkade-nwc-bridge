// Hand-rolled minimal stubs for @arkade-os/sdk Wallet and
// @arkade-os/boltz-swap ArkadeSwaps. Cast through `unknown` so we don't have
// to satisfy the full interface — handlers only touch a small slice. If an
// SDK upgrade changes one of the methods we *do* use, the cast surfaces the
// drift at the call site rather than silently swallowing it.

import type {
  Wallet,
  WalletBalance,
  ArkTransaction,
  ArkInfo,
  ExtendedVirtualCoin,
  RestArkProvider,
} from '@arkade-os/sdk'
import type {
  ArkadeSwaps,
  CreateLightningInvoiceRequest,
  CreateLightningInvoiceResponse,
  SendLightningPaymentRequest,
  SendLightningPaymentResponse,
} from '@arkade-os/boltz-swap'
import { AsyncCache } from '../../src/lib/cache'
import type { SwrCaches } from '../../src/web/server'

export function emptyBalance(overrides: Partial<WalletBalance> = {}): WalletBalance {
  return {
    boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
    settled: 0,
    preconfirmed: 0,
    available: 0,
    recoverable: 0,
    total: 0,
    ...overrides,
  } as WalletBalance
}

export interface WalletStubOptions {
  balance?: WalletBalance
  address?: string
  history?: ArkTransaction[]
  vtxos?: ExtendedVirtualCoin[]
}

export function makeWalletStub(opts: WalletStubOptions = {}): Wallet {
  return {
    async getBalance() {
      return opts.balance ?? emptyBalance()
    },
    async getAddress() {
      return opts.address ?? 'tark1stub'
    },
    async getTransactionHistory() {
      return opts.history ?? []
    },
    async getVtxos() {
      return opts.vtxos ?? []
    },
    async sendBitcoin() {
      return 'arktxid-stub'
    },
    async settle() {
      return 'settletxid-stub'
    },
  } as unknown as Wallet
}

/**
 * Minimal RestArkProvider stub — /send reads dust + intent-fee programs from
 * getInfo(). Default: dust 330, empty fee programs (fee = 0, matching policy).
 */
export function makeArkProviderStub(
  opts: { dust?: bigint; intentFee?: Record<string, string> } = {},
): RestArkProvider {
  const info = {
    dust: opts.dust ?? 330n,
    fees: { intentFee: opts.intentFee ?? {}, txFeeRate: '1' },
  } as unknown as ArkInfo
  return {
    async getInfo() {
      return info
    },
  } as unknown as RestArkProvider
}

/**
 * Build SwrCaches around a wallet stub and seed them with the same
 * snapshot the real bootReady would seed at boot. Tests that drive the
 * web server need ready-state caches so `/` and `/history` don't render
 * "Loading…" placeholders.
 */
export function makeSwrCaches(wallet: Wallet, balance: WalletBalance): SwrCaches {
  const caches: SwrCaches = {
    balance: new AsyncCache({ label: 'test-balance', fetcher: () => wallet.getBalance() }),
    history: new AsyncCache({
      label: 'test-history',
      fetcher: () => wallet.getTransactionHistory(),
    }),
  }
  caches.balance.seed(balance)
  return caches
}

export interface SwapsStubOptions {
  createLightningInvoice?: (
    args: CreateLightningInvoiceRequest,
  ) => Promise<CreateLightningInvoiceResponse>
  sendLightningPayment?: (
    args: SendLightningPaymentRequest,
  ) => Promise<SendLightningPaymentResponse>
}

export function makeSwapsStub(opts: SwapsStubOptions = {}): ArkadeSwaps {
  return {
    createLightningInvoice:
      opts.createLightningInvoice ??
      (async () => {
        throw new Error('createLightningInvoice not stubbed')
      }),
    sendLightningPayment:
      opts.sendLightningPayment ??
      (async () => {
        throw new Error('sendLightningPayment not stubbed')
      }),
  } as unknown as ArkadeSwaps
}

/**
 * A pre-baked CreateLightningInvoiceResponse-shaped record. Tests can spread
 * over it to tweak individual fields without re-specifying the rest.
 */
export function fakeInvoiceResponse(
  overrides: Partial<CreateLightningInvoiceResponse> = {},
): CreateLightningInvoiceResponse {
  return {
    amount: 99,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    invoice: 'lnbcfake',
    paymentHash: 'ff'.repeat(32),
    pendingSwap: { id: 'swap-id-fake' },
    ...overrides,
  } as unknown as CreateLightningInvoiceResponse
}

export function fakePaymentResponse(
  overrides: Partial<SendLightningPaymentResponse> = {},
): SendLightningPaymentResponse {
  return {
    amount: 105,
    preimage: 'aa'.repeat(32),
    txid: 'cc'.repeat(32),
    ...overrides,
  } as SendLightningPaymentResponse
}
