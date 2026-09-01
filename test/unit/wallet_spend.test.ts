import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { ExtendedVirtualCoin, Wallet } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { fakeTxid } from '../helpers/evidence'
import {
  HOT_POCKET_COUNT,
  HOT_POCKET_SATS,
  hotPocketsNeeded,
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
    // multi-recipient: splitHotPocket carves every lane in one call
    send: async (...recipients: { address: string; amount: number }[]) => {
      for (const r of recipients) calls.send.push({ address: r.address, amount: r.amount })
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

describe('hotPocketsNeeded', () => {
  const D = Number(DUST)

  test('a freshly consolidated single VTXO wants the full set carved out', () => {
    expect(hotPocketsNeeded([vtxo(500_000)], D)).toBe(HOT_POCKET_COUNT)
  })

  test('existing small coins count as pockets — only the shortfall is carved', () => {
    // Including WORN ones: they are still ≤ HOT_POCKET_SATS and still usable as
    // a lane, so a wallet that has merely been spending down never re-splits.
    expect(hotPocketsNeeded([vtxo(500_000), vtxo(400)], D)).toBe(HOT_POCKET_COUNT - 1)
    expect(hotPocketsNeeded([vtxo(500_000), vtxo(HOT_POCKET_SATS)], D)).toBe(HOT_POCKET_COUNT - 1)
  })

  test('a full set of lanes wants nothing', () => {
    const pool = [vtxo(500_000), ...Array.from({ length: HOT_POCKET_COUNT }, () => vtxo(1_000))]
    expect(hotPocketsNeeded(pool, D)).toBe(0)
  })

  test('capped by what the biggest coin can spare above dust', () => {
    // room for exactly one pocket plus a cold coin ≥ dust
    expect(hotPocketsNeeded([vtxo(HOT_POCKET_SATS + D)], D)).toBe(1)
    expect(hotPocketsNeeded([vtxo(HOT_POCKET_SATS + D - 1)], D)).toBe(0)
    expect(hotPocketsNeeded([vtxo(2 * HOT_POCKET_SATS + D)], D)).toBe(2)
  })

  test('an empty wallet is not a candidate', () => {
    expect(hotPocketsNeeded([], D)).toBe(0)
  })
})

describe('splitHotPocket', () => {
  test('carves the whole set in ONE self-send — N lanes cost the same one hop', async () => {
    const { wallet, calls } = stubWallet([vtxo(500_000)])
    const txid = await splitHotPocket({ wallet, db, arkInfo: arkInfo() })
    expect(txid).toBe('tx-sdk')
    expect(calls.send).toHaveLength(HOT_POCKET_COUNT)
    expect(calls.send.every((c) => c.address === ARK_ADDR && c.amount === HOT_POCKET_SATS)).toBe(true)
    expect(calls.sendBitcoin).toEqual([]) // NOT the explicit-selection path
  })

  test('tops up only the missing lanes', async () => {
    const { wallet, calls } = stubWallet([vtxo(500_000), vtxo(4_000)])
    await splitHotPocket({ wallet, db, arkInfo: arkInfo() })
    expect(calls.send).toHaveLength(HOT_POCKET_COUNT - 1)
  })

  test('no-ops when every lane already exists', async () => {
    const pool = [vtxo(500_000), ...Array.from({ length: HOT_POCKET_COUNT }, () => vtxo(4_000))]
    const { wallet, calls } = stubWallet(pool)
    expect(await splitHotPocket({ wallet, db, arkInfo: arkInfo() })).toBeUndefined()
    expect(calls.send).toEqual([])
  })
})
