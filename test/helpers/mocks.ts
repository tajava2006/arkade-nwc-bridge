// Hand-rolled minimal stubs for the @arkade-os/sdk Wallet and the bridge's
// Lightning rails. Cast through `unknown` so we don't have
// to satisfy the full interface — handlers only touch a small slice. If an
// SDK upgrade changes one of the methods we *do* use, the cast surfaces the
// drift at the call site rather than silently swallowing it.

import { bech32 } from '@scure/base'
import type {
  Wallet,
  WalletBalance,
  ArkTransaction,
  OperatorInfo,
  ExtendedVirtualCoin,
  RestArkProvider,
} from '@arkade-os/sdk'
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
  /** override send() — capture funding args or fail the path on purpose */
  sendImpl?: (args: { address: string; amount: number }) => Promise<string>
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
    async getSpendableVtxos() {
      return opts.vtxos ?? []
    },
    // SDK 0.5 has one send(): a Recipient, or { recipients, selectedVtxos } — the
    // explicit-selection form the spend funnel (wallet_spend.sendSelected) uses.
    // Both land in the same recorder, so neither path looks like a no-op.
    async send(
      args:
        | { address: string; amount: number }
        | { recipients: { address: string; amount: number }[]; selectedVtxos?: unknown[] },
    ) {
      const flat = 'recipients' in args ? { ...args.recipients[0]!, selectedVtxos: args.selectedVtxos } : args
      return opts.sendImpl ? opts.sendImpl(flat as never) : 'arktxid-stub'
    },
    async settle() {
      return 'settletxid-stub'
    },
    // The atomic receive puts the wallet's x-only key into the swap script.
    identity: { xOnlyPublicKey: async () => new Uint8Array(32).fill(7) },
  } as unknown as Wallet
}

/**
 * subdustd's /receive/init, offline: records each request body and answers
 * with `invoice` (default: INVOICE_2000_SAT re-hashed to the request's own
 * payment hash, so the returned invoice and the stored swap agree).
 */
export function stubSubdustdReceive(subdustdUrl: string, invoice?: string): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url) !== `${subdustdUrl}/v2/subdust/atomic/receive/init`) throw new Error(`unexpected fetch ${url}`)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    const inv = invoice ?? invoiceWithHash(String(body.paymentHash))
    // like subdustd: the VHTLC from dust up (the bridge refuses a 4-leaf there)
    const script = Number(body.amount) >= 330 ? 'vhtlc' : 'atomic4'
    return new Response(JSON.stringify({ swapId: `swap-${bodies.length}`, invoice: inv, script }), { status: 201, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { bodies }
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
  } as unknown as OperatorInfo
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
      fetcher: async () => ({ arkInfo: {} as never, vtxos: [], lnFeePercent: 0.5 }),
    }),
  }
  caches.balance.seed(balance)
  return caches
}

/**
 * 20μBTC = 2000 sat mainnet invoice with a valid bech32 checksum, borrowed
 * from light-bolt11-decoder's own test vectors. Long expired — tests only
 * ever decode it, never pay it. Use this (not a short stub) wherever a mock
 * boltz response feeds issueInvoice: absoluteExpiry now bech32-decodes the
 * returned invoice string, so anything under 8 chars throws. The nominal
 * being 2000 sats doesn't matter to the branch under test — paymentHash and
 * the invoice string are what the assertions read.
 */
export const INVOICE_2000_SAT =
  'lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567'

/**
 * Amount variants of INVOICE_2000_SAT: same data part, re-checksummed under a
 * different HRP. The embedded signature no longer matches, but
 * light-bolt11-decoder never verifies it — these exist purely so amount-based
 * branch selection (ln_send's sub-dust cutoff) can be driven with realistic
 * bolt11 strings. 210n = 21 sats; no amount decodes as 0.
 */
const reAmount = (hrp: string): string =>
  bech32.encode(hrp, bech32.decode(INVOICE_2000_SAT as never, false).words, false)
export const INVOICE_21_SAT = reAmount('lnbc210n')
export const INVOICE_328_SAT = reAmount('lnbc3280n')
export const INVOICE_NO_AMOUNT = reAmount('lnbc')


/**
 * INVOICE_2000_SAT (or a reAmount variant) with its payment-hash tag replaced,
 * so a test can know the preimage: the ledger only accepts a preimage that
 * hashes to the invoice's own payment hash. Same caveat as reAmount — the
 * signature stops matching, which the decoder never checks.
 */
export function invoiceWithHash(paymentHashHex: string, base: string = INVOICE_2000_SAT): string {
  const { prefix, words } = bech32.decode(base as never, false)
  const out = [...words]
  const sigStart = out.length - 104
  for (let i = 7; i < sigStart; ) {
    const type = out[i]!
    const len = out[i + 1]! * 32 + out[i + 2]!
    if (type === 1 && len === 52) {
      const hashWords = bech32.toWords(Buffer.from(paymentHashHex, 'hex'))
      out.splice(i + 3, 52, ...hashWords)
      return bech32.encode(prefix, out, false)
    }
    i += 3 + len
  }
  throw new Error('no payment hash tag')
}

/** A preimage and the INVOICE_2000_SAT-shaped invoice locked to its hash. */
export function knownPreimageInvoice(base?: string): { preimage: string; paymentHash: string; invoice: string } {
  const preimage = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')
  const paymentHash = new Bun.CryptoHasher('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash, invoice: invoiceWithHash(paymentHash, base) }
}

export interface LightningStubOptions {
  /** Thrown before any value moved (e.g. LnSendRefused). */
  payError?: Error
  /** How the send ends. Default 'paid'. */
  outcome?: 'paid' | 'failed' | 'unresolved'
  /** Fee in sats (what left the wallet = invoice + fee). */
  feeSats?: number
  /** The preimage a paid send returns. */
  preimage?: string
  swapId?: string
}

/**
 * The bridge's Lightning rail plus a scripted `send` for handlers that take
 * one (pay_invoice): the real atomic send needs arkd and subdustd and runs on
 * regtest; this one returns or throws the way sendLightning does.
 */
export function makeLightningStub(opts: LightningStubOptions = {}): {
  lightning: import('../../src/ln_send').LightningRails
  send: typeof import('../../src/ln_send').sendLightning
  paid: string[]
} {
  const paid: string[] = []
  const send: typeof import('../../src/ln_send').sendLightning = async (_deps, invoice) => {
    if (opts.payError) throw opts.payError
    paid.push(invoice)
    const { decodeInvoice } = await import('../../src/lib/bolt11')
    const { LnSendUnresolved } = await import('../../src/ln_send')
    if (opts.outcome === 'failed') throw new Error('LN pay failed (FAILURE_REASON_NO_ROUTE)')
    if (opts.outcome === 'unresolved') throw new LnSendUnresolved('payment outcome unknown — resolving in the background')
    const sats = decodeInvoice(invoice).amountSats ?? 0
    return { amount: sats + (opts.feeSats ?? 0), preimage: opts.preimage ?? '', txid: 'arktxid-funding', swapId: opts.swapId ?? 'atomic-swap-1' }
  }
  return { lightning: { subdustdUrl: 'http://subdustd.invalid' }, send, paid }
}
