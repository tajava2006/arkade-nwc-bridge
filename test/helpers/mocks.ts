// Hand-rolled minimal stubs for @arkade-os/sdk Wallet and
// @arkade-os/boltz-swap ArkadeSwaps. Cast through `unknown` so we don't have
// to satisfy the full interface — handlers only touch a small slice. If an
// SDK upgrade changes one of the methods we *do* use, the cast surfaces the
// drift at the call site rather than silently swallowing it.

import type { Wallet, WalletBalance, ArkTransaction } from '@arkade-os/sdk'
import type {
  ArkadeSwaps,
  CreateLightningInvoiceRequest,
  CreateLightningInvoiceResponse,
  SendLightningPaymentRequest,
  SendLightningPaymentResponse,
} from '@arkade-os/boltz-swap'

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
  } as unknown as Wallet
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
