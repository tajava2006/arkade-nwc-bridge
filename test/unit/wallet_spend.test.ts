import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { ExtendedVirtualCoin, Wallet } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { fakeTxid } from '../helpers/evidence'
import {
  HOT_POCKET_SATS,
  needsHotPocket,
  sendSelected,
  splitHotPocket,
} from '../../src/wallet_spend'

// sendSelected is the single funnel every offchain spend goes through, so the
// contract worth pinning is: it selects explicitly, it hands the choice BACK to
// the SDK when explicit selection would be unsafe, and it explains a refusal.

const DUST = 330n
const ARK_ADDR = 'ark1qexampledestination'

let t: TempDb
let db: Database
beforeEach(() => {
  t = openTempDb()
  db = t.db
})
afterEach(() => t.cleanup())

let seq = 0
const vtxo = (value: number): ExtendedVirtualCoin =>
  ({ txid: fakeTxid(0x40 + seq++), vout: 0, value }) as unknown as ExtendedVirtualCoin

interface Calls {
  sendBitcoin: { address: string; amount: number; selected: number[] }[]
  send: { address: string; amount: number }[]
}

function stubWallet(pool: ExtendedVirtualCoin[]): { wallet: Wallet; calls: Calls } {
  const calls: Calls = { sendBitcoin: [], send: [] }
  const wallet = {
    getVtxos: async () => pool,
    getAddress: async () => ARK_ADDR,
    sendBitcoin: async (p: { address: string; amount: number; selectedVtxos?: ExtendedVirtualCoin[] }) => {
      calls.sendBitcoin.push({
        address: p.address,
        amount: p.amount,
        selected: (p.selectedVtxos ?? []).map((v) => v.value),
      })
      return 'tx-explicit'
    },
    send: async (p: { address: string; amount: number }) => {
      calls.send.push({ address: p.address, amount: p.amount })
      return 'tx-sdk'
    },
  } as unknown as Wallet
  return { wallet, calls }
}

const arkInfo = (deprecated: unknown[] = []) =>
  ({ dust: DUST, deprecatedSigners: deprecated }) as never

describe('sendSelected', () => {
  test('spends one covering coin explicitly rather than letting the SDK pick', () => {
    // The SDK's selector takes the LARGEST coin (expiry asc, value desc) — here
    // it would grab 100_000 and chain the coin we want left alone.
    const { wallet, calls } = stubWallet([vtxo(100_000), vtxo(4_000)])
    return sendSelected({ wallet, db, arkInfo: arkInfo() }, { address: ARK_ADDR, amount: 1_000 }).then((txid) => {
      expect(txid).toBe('tx-explicit')
      expect(calls.send).toEqual([])
      expect(calls.sendBitcoin[0]!.selected).toEqual([4_000])
    })
  })

  test('hands selection back to the SDK when the ASP advertises deprecated signers', async () => {
    // sendBitcoin({selectedVtxos}) skips the pendingRecoveryOutpoints() filter
    // that only matters in exactly that case. Correctness beats coin policy.
    const { wallet, calls } = stubWallet([vtxo(100_000), vtxo(4_000)])
    const txid = await sendSelected(
      { wallet, db, arkInfo: arkInfo([{ pubkey: 'ab'.repeat(32) }]) },
      { address: ARK_ADDR, amount: 1_000 },
    )
    expect(txid).toBe('tx-sdk')
    expect(calls.sendBitcoin).toEqual([])
  })

  test('reuses a pool the caller already read (drain sizing must not re-read)', async () => {
    const { wallet, calls } = stubWallet([vtxo(1)]) // would be wrong if re-read
    const pool = [vtxo(9_000)]
    await sendSelected({ wallet, db, arkInfo: arkInfo() }, { address: ARK_ADDR, amount: 1_000, pool })
    expect(calls.sendBitcoin[0]!.selected).toEqual([9_000])
  })

  test('a drain (amount === pool total) selects everything and leaves no change', async () => {
    const pool = [vtxo(3_000), vtxo(2_000)]
    const { wallet, calls } = stubWallet(pool)
    await sendSelected({ wallet, db, arkInfo: arkInfo() }, { address: ARK_ADDR, amount: 5_000 })
    expect(calls.sendBitcoin[0]!.selected.sort()).toEqual([2_000, 3_000])
  })

  test('too little money → the error says how much is spendable', async () => {
    const { wallet } = stubWallet([vtxo(1_000)])
    await expect(
      sendSelected({ wallet, db, arkInfo: arkInfo() }, { address: ARK_ADDR, amount: 5_000 }),
    ).rejects.toThrow(/only 1000 are offchain-spendable/)
  })

  test('enough money but only sub-dust-change shapes → a DIFFERENT, explicit error', async () => {
    // 1_000 − 800 = 200 < dust. Reporting "insufficient funds" here would be a
    // lie and would send the operator hunting for a balance bug.
    const { wallet } = stubWallet([vtxo(1_000)])
    await expect(
      sendSelected({ wallet, db, arkInfo: arkInfo() }, { address: ARK_ADDR, amount: 800 }),
    ).rejects.toThrow(/can't be composed without leaving sub-dust change/)
  })
})

describe('needsHotPocket', () => {
  test('a freshly consolidated single VTXO wants a pocket carved out', () => {
    expect(needsHotPocket([vtxo(500_000)], Number(DUST))).toBe(true)
  })

  test('a wallet that already has a small coin does not', () => {
    // Including a WORN pocket: it is still ≤ HOT_POCKET_SATS, and re-splitting
    // would just add another hop to cold for no benefit.
    expect(needsHotPocket([vtxo(500_000), vtxo(400)], Number(DUST))).toBe(false)
    expect(needsHotPocket([vtxo(500_000), vtxo(HOT_POCKET_SATS)], Number(DUST))).toBe(false)
  })

  test('too poor to leave a cold coin above dust → no split', () => {
    expect(needsHotPocket([vtxo(HOT_POCKET_SATS + Number(DUST) - 1)], Number(DUST))).toBe(false)
    expect(needsHotPocket([vtxo(HOT_POCKET_SATS + Number(DUST))], Number(DUST))).toBe(true)
  })

  test('an empty wallet is not a candidate', () => {
    expect(needsHotPocket([], Number(DUST))).toBe(false)
  })
})

describe('splitHotPocket', () => {
  test('carves exactly one pocket via a plain self-send (SDK picks the big coin)', async () => {
    const { wallet, calls } = stubWallet([vtxo(500_000)])
    const txid = await splitHotPocket({ wallet, db, arkInfo: arkInfo() })
    expect(txid).toBe('tx-sdk')
    expect(calls.send).toEqual([{ address: ARK_ADDR, amount: HOT_POCKET_SATS }])
    expect(calls.sendBitcoin).toEqual([]) // NOT the explicit path
  })

  test('no-ops when a pocket already exists', async () => {
    const { wallet, calls } = stubWallet([vtxo(500_000), vtxo(4_000)])
    expect(await splitHotPocket({ wallet, db, arkInfo: arkInfo() })).toBeUndefined()
    expect(calls.send).toEqual([])
  })
})
