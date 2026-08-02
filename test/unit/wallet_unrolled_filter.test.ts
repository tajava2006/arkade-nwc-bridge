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

describe('installUnrolledVtxoFilter', () => {
  test('patches getVtxos in place and forwards the original filter', async () => {
    const seen: (GetVtxosFilter | undefined)[] = []
    const wallet = {
      async getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
        seen.push(filter)
        return [GHOST, LIVE]
      },
    }
    installUnrolledVtxoFilter(wallet)

    expect(await wallet.getVtxos()).toEqual([LIVE])
    expect(await wallet.getVtxos({ withRecoverable: true })).toEqual([LIVE])
    expect(await wallet.getVtxos({ withUnrolled: true })).toEqual([GHOST, LIVE])
    // the SDK still receives exactly what the caller asked for
    expect(seen).toEqual([undefined, { withRecoverable: true }, { withUnrolled: true }])
  })
})
