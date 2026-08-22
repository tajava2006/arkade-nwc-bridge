import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { sendLightning } from '../../src/ln_send'
import {
  INVOICE_2000_SAT,
  INVOICE_NO_AMOUNT,
  fakeSpendableVtxo,
  fakeSubmarineSwap,
  makeSwapsStub,
  makeWalletStub,
} from '../helpers/mocks'

// The single LN-send entry point (NWC pay_invoice + dashboard /send both funnel
// here). The ≥dust submarine flow is also exercised through handlers.test; THIS
// file owns the drain/insufficient-funding edges on the submarine rail.
//
// The sub-dust branch (<330) now routes through the ATOMIC path (atomic_send.ts
// → boltz /v2/subdust/atomic/send/*), which funds a shared vtxo, pre-signs, and
// submits over the SDK's ark providers — too network/wallet-coupled to mock
// meaningfully here. It's validated end-to-end in the regtest drill (#14),
// replacing the removed non-atomic plain-path unit tests.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

// The submarine rail never touches the atomic sub-dust deps; a throwaway db and
// empty ASP url satisfy the type without being read.
const noAtomic = {
  arkServerUrl: '',
  db: new Database(':memory:'),
  // The submarine rail reads dust (change guard) + deprecatedSigners
  // (explicit-selection safety valve) before choosing inputs. Injected so
  // these stay offline unit tests.
  getArkInfo: async () => ({ dust: 330n, deprecatedSigners: [] }) as never,
}

describe('sendLightning — submarine rail (≥ dust / amountless)', () => {
  test('near-drain overfunds the lockup instead of stranding change', async () => {
    const swaps = makeSwapsStub({
      createSubmarineSwap: async () => fakeSubmarineSwap({ expectedAmount: 2005 }),
      waitForSwapSettlement: async () => ({ preimage: 'cd'.repeat(32) }),
    })
    const sends: { address: string; amount: number; selectedVtxos?: { value: number }[] }[] = []
    const wallet = makeWalletStub({
      vtxos: [fakeSpendableVtxo(2006)], // 1 sat over — inside the slack
      sendImpl: async (args) => {
        sends.push(args)
        return 'arktxid-lockup'
      },
    })
    const res = await sendLightning({ swaps, wallet, boltzApiUrl: '', ...noAtomic }, INVOICE_2000_SAT)
    expect(sends[0]!.address).toBe('tark1boltzlockup')
    expect(sends[0]!.amount).toBe(2006)
    // The rail picks inputs itself now (wallet_spend.sendSelected) instead of
    // letting the SDK's value-descending selector reach for the biggest coin.
    expect((sends[0] as { selectedVtxos?: { value: number }[] }).selectedVtxos?.map((v) => v.value)).toEqual([2006])
    expect(res).toEqual({ amount: 2006, preimage: 'cd'.repeat(32), txid: 'arktxid-lockup', swapId: 'swap-id-fake' })
  })

  test('an amountless invoice routes submarine, never the sub-dust path', async () => {
    globalThis.fetch = (async () => {
      throw new Error('sub-dust path must not be used for amountless invoices')
    }) as unknown as typeof fetch
    const swaps = makeSwapsStub({
      createSubmarineSwap: async (args) => {
        expect(args.invoice).toBe(INVOICE_NO_AMOUNT)
        return fakeSubmarineSwap({ expectedAmount: 500 })
      },
      waitForSwapSettlement: async () => ({ preimage: 'ee'.repeat(32) }),
    })
    const wallet = makeWalletStub({ vtxos: [fakeSpendableVtxo(10_000)] })
    const res = await sendLightning({ swaps, wallet, boltzApiUrl: '', ...noAtomic }, INVOICE_NO_AMOUNT)
    expect(res.amount).toBe(500)
  })

  test('a swap response without an address is a hard error before any send', async () => {
    const swaps = makeSwapsStub({
      createSubmarineSwap: async () => fakeSubmarineSwap({ address: '' }),
    })
    const wallet = makeWalletStub({
      vtxos: [fakeSpendableVtxo(10_000)],
      sendImpl: async () => {
        throw new Error('must not reach wallet.send')
      },
    })
    await expect(
      sendLightning({ swaps, wallet, boltzApiUrl: '', ...noAtomic }, INVOICE_2000_SAT),
    ).rejects.toThrow(/missing address/)
  })
})
