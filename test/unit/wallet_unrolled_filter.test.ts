import { describe, expect, test } from 'bun:test'
import type { ExtendedVirtualCoin, GetVtxosFilter } from '@arkade-os/sdk'
import { installUnrolledVtxoFilter, withoutUnrolled } from '../../src/wallet'

// The scenario under guard: an unrolled-but-unspent vtxo. arkd reports it
// with isSpent=false forever (spent tracks offchain spends only; the batch
// sweeper skips unrolled leaves), and the SDK's getVtxos consults
// withUnrolled only behind hasTerminalSpend — so without the boundary
// filter this coin passes as plain spendable into balance/send/settle.
const coin = (txid: string, isUnrolled: boolean): ExtendedVirtualCoin =>
  ({
    txid,
    vout: 0,
    value: 1000,
    isSpent: false,
    isUnrolled,
    virtualStatus: { state: 'settled' },
  }) as unknown as ExtendedVirtualCoin

const GHOST = coin('aa'.repeat(32), true)
const LIVE = coin('bb'.repeat(32), false)

describe('withoutUnrolled', () => {
  test('no filter (the getBalance/settle path) drops unrolled coins', () => {
    expect(withoutUnrolled([GHOST, LIVE])).toEqual([LIVE])
  })

  test('a filter without withUnrolled (send/sendData path) drops them too', () => {
    expect(withoutUnrolled([GHOST, LIVE], { withRecoverable: true })).toEqual([LIVE])
  })

  test('withUnrolled: true is the explicit opt-in and passes everything', () => {
    expect(withoutUnrolled([GHOST, LIVE], { withUnrolled: true })).toEqual([GHOST, LIVE])
  })
})

/** A wallet stub shaped like the SDK's: both boundaries present. */
function fakeWallet(rows: ExtendedVirtualCoin[] = [GHOST, LIVE]) {
  const seen: (GetVtxosFilter | undefined)[] = []
  const wallet = {
    seen,
    async getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
      seen.push(filter)
      return rows
    },
    async contractSnapshot(): Promise<{ contract: { script: string }; vtxos: ExtendedVirtualCoin[] }[]> {
      return [{ contract: { script: 'aa' }, vtxos: rows }]
    },
  }
  return wallet
}

describe('installUnrolledVtxoFilter', () => {
  test('patches getVtxos in place and forwards the original filter', async () => {
    const wallet = fakeWallet()
    installUnrolledVtxoFilter(wallet)

    expect(await wallet.getVtxos()).toEqual([LIVE])
    expect(await wallet.getVtxos({ withRecoverable: true })).toEqual([LIVE])
    expect(await wallet.getVtxos({ withUnrolled: true })).toEqual([GHOST, LIVE])
    // the SDK still receives exactly what the caller asked for
    expect(wallet.seen).toEqual([undefined, { withRecoverable: true }, { withUnrolled: true }])
  })

  // SDK 0.4.62 moved getBalance and settle()'s input selection off getVtxos and
  // onto contractSnapshot / getSpendableVtxos, which both read the snapshot —
  // so the snapshot is the boundary that actually covers every reader.
  test('filters the contract snapshot, which is what getBalance and settle read', async () => {
    const wallet = fakeWallet()
    installUnrolledVtxoFilter(wallet)

    const snap = await wallet.contractSnapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]!.vtxos).toEqual([LIVE])
    // the rest of the entry survives untouched
    expect(snap[0]!.contract).toEqual({ script: 'aa' })
  })

  test('throws rather than silently losing the filter if the SDK moves the boundary', () => {
    const noSnapshot = {
      async getVtxos(): Promise<ExtendedVirtualCoin[]> {
        return [GHOST, LIVE]
      },
    }
    expect(() => installUnrolledVtxoFilter(noSnapshot)).toThrow(/contractSnapshot is missing/)
  })
})
