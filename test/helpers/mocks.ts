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
  BoltzSubmarineSwap,
  CreateLightningInvoiceRequest,
  CreateLightningInvoiceResponse,
  SendLightningPaymentRequest,
  SendLightningPaymentResponse,
} from '@arkade-os/boltz-swap'
import { AsyncCache } from '../../src/lib/cache'
import type { SwrCaches } from '../../src/web/server'
import type { SendData } from '../../src/send'

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

/** Minimal spendable vtxo for ln_send's balance sum — only `value` is read. */
export function fakeSpendableVtxo(value: number): ExtendedVirtualCoin {
  return { value } as unknown as ExtendedVirtualCoin
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
    async send() {
      return 'arktxid-stub'
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
 * web server need ready-state caches so `/` doesn't render
 * "Loading…" placeholders.
 */
export function makeSwrCaches(wallet: Wallet, balance: WalletBalance): SwrCaches {
  const caches: SwrCaches = {
    balance: new AsyncCache({ label: 'test-balance', fetcher: () => wallet.getBalance() }),
    sendData: new AsyncCache<SendData>({
      label: 'test-send-data',
      // fees carries enough shape for drainHint should a test ever render a
      // non-empty breakdown (empty vtxos short-circuit before touching it).
      fetcher: async () => ({
        arkInfo: {} as never,
        vtxos: [],
        fees: { submarine: { percentage: 0.1, minerFees: 0 } } as never,
      }),
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
  createSubmarineSwap?: (args: SendLightningPaymentRequest) => Promise<BoltzSubmarineSwap>
  waitForSwapSettlement?: (pendingSwap: BoltzSubmarineSwap) => Promise<{ preimage: string }>
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
    createSubmarineSwap:
      opts.createSubmarineSwap ??
      (async () => {
        throw new Error('createSubmarineSwap not stubbed')
      }),
    waitForSwapSettlement:
      opts.waitForSwapSettlement ??
      (async () => {
        throw new Error('waitForSwapSettlement not stubbed')
      }),
    async getFees() {
      return {
        submarine: { percentage: 0.1, minerFees: 0 },
        reverse: { percentage: 0.25, minerFees: { lockup: 0, claim: 0 } },
      }
    },
  } as unknown as ArkadeSwaps
}

/**
 * A pre-baked pending submarine swap, shaped like createSubmarineSwap's
 * return: ln_send only reads response.address + response.expectedAmount.
 */
export function fakeSubmarineSwap(
  overrides: { expectedAmount?: number; address?: string } = {},
): BoltzSubmarineSwap {
  return {
    id: 'swap-id-fake',
    type: 'submarine',
    response: {
      address: overrides.address ?? 'tark1boltzlockup',
      expectedAmount: overrides.expectedAmount ?? 105,
    },
  } as unknown as BoltzSubmarineSwap
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

/**
 * 20μBTC = 2000 sat mainnet invoice with a valid bech32 checksum, borrowed
 * from light-bolt11-decoder's own test vectors. Long expired — tests only
 * ever decode it, never pay it. Also stands in for boltz's sub-dust plain
 * invoices: issueInvoice only decodes paymentHash/expiry from what boltz
 * returns, so the nominal being 2000 sats doesn't matter to the branch
 * under test.
 */
export const INVOICE_2000_SAT =
  'lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567'

