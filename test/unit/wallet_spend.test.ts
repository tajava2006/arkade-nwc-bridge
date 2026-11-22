import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { ExtendedVirtualCoin, Wallet } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import { fakeTxid } from '../helpers/evidence'
import {
  HOT_POCKET_COUNT,
  HOT_POCKET_SATS,
  hotPocketsNeeded,
  DRAIN_SLACK_SATS,
  sendSelected,
  splitHotPocket,
  withSpendPolicy,
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
  explicit: { address: string; amount: number; selected: number[] }[]
  send: { address: string; amount: number }[]
}

function stubWallet(pool: ExtendedVirtualCoin[]): { wallet: Wallet; calls: Calls } {
  const calls: Calls = { explicit: [], send: [] }
  const wallet = {
    getVtxos: async () => pool,
    getSpendableVtxos: async () => pool,
    getAddress: async () => ARK_ADDR,
    // SDK 0.5: one send(). The object form with selectedVtxos is the explicit
    // path (0.4's sendBitcoin); recipients alone let the SDK select.
    send: async (...args: unknown[]) => {
      const first = args[0] as { recipients?: { address: string; amount: number }[]; selectedVtxos?: ExtendedVirtualCoin[] }
      if (first && 'recipients' in first) {
        const r = first.recipients![0]!
        calls.explicit.push({ address: r.address, amount: r.amount, selected: (first.selectedVtxos ?? []).map((v) => v.value) })
        return 'tx-explicit'
      }
      for (const r of args as { address: string; amount: number }[]) calls.send.push({ address: r.address, amount: r.amount })
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
      expect(calls.explicit[0]!.selected).toEqual([4_000])
    })
  })

  test('hands selection back to the SDK when the ASP advertises deprecated signers', async () => {
    // send({ selectedVtxos }) skips the pendingRecoveryOutpoints() filter
    // that only matters in exactly that case. Correctness beats coin policy.
    const { wallet, calls } = stubWallet([vtxo(100_000), vtxo(4_000)])
    const txid = await sendSelected(
      { wallet, db, arkInfo: arkInfo([{ pubkey: 'ab'.repeat(32) }]) },
      { address: ARK_ADDR, amount: 1_000 },
    )
    expect(txid).toBe('tx-sdk')
    expect(calls.explicit).toEqual([])
  })

  test('reuses a pool the caller already read (drain sizing must not re-read)', async () => {
    const { wallet, calls } = stubWallet([vtxo(1)]) // would be wrong if re-read
    const pool = [vtxo(9_000)]
    await sendSelected({ wallet, db, arkInfo: arkInfo() }, { address: ARK_ADDR, amount: 1_000, pool })
    expect(calls.explicit[0]!.selected).toEqual([9_000])
  })

  test('a drain (amount === pool total) selects everything and leaves no change', async () => {
    const pool = [vtxo(3_000), vtxo(2_000)]
    const { wallet, calls } = stubWallet(pool)
    await sendSelected({ wallet, db, arkInfo: arkInfo() }, { address: ARK_ADDR, amount: 5_000 })
    expect(calls.explicit[0]!.selected.sort()).toEqual([2_000, 3_000])
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
    expect(calls.explicit).toEqual([]) // NOT the explicit-selection path
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

describe('sendSelected — drain residue and deadline', () => {
  test('a residue of ≤ DRAIN_SLACK_SATS spends the whole pool (the residue stays as sub-dust change)', async () => {
    const calls: Record<string, unknown>[] = []
    const pool = [vtxo(3_000), vtxo(2_001)]
    const wallet = { getSpendableVtxos: async () => pool, send: async (p: Record<string, unknown>) => (calls.push(p), 'tx') } as unknown as Wallet
    await sendSelected({ wallet, db, arkInfo: arkInfo() }, { address: ARK_ADDR, amount: 5_000, validUntil: 1234 })
    expect((calls[0]!.selectedVtxos as ExtendedVirtualCoin[]).map((v) => v.value).sort()).toEqual([2_001, 3_000])
    expect(calls[0]!.maxChangeFee).toBeUndefined()
    expect(calls[0]!.validUntil).toBe(1234)
  })

  test('a residue just past the slack is still refused as sub-dust change', async () => {
    const wallet = { getSpendableVtxos: async () => [vtxo(5_000 + DRAIN_SLACK_SATS + 1)], send: async () => 'tx' } as unknown as Wallet
    await expect(sendSelected({ wallet, db, arkInfo: arkInfo() }, { address: ARK_ADDR, amount: 5_000 })).rejects.toThrow(/sub-dust change/)
  })
})

describe('withSpendPolicy', () => {
  const setup = () => {
    const calls: unknown[][] = []
    const raw = {
      tag: 'raw',
      getSpendableVtxos: async () => [vtxo(100_000), vtxo(4_000)],
      send: async (...args: unknown[]) => (calls.push(args), 'tx'),
      whoami() {
        return (this as { tag: string }).tag
      },
    }
    const wrapped = withSpendPolicy(raw as unknown as Wallet, { db, arkInfo: async () => arkInfo() })
    return { calls, wrapped: wrapped as unknown as typeof raw }
  }

  test("the swap client's plain lockup funding goes through our selector, deadline kept", async () => {
    const { calls, wrapped } = setup()
    await wrapped.send({ recipients: [{ address: ARK_ADDR, amount: 1_000 }], validUntil: 99 } as never)
    const p = calls[0]![0] as { selectedVtxos: ExtendedVirtualCoin[]; validUntil: number }
    expect(p.selectedVtxos.map((v) => v.value)).toEqual([4_000])
    expect(p.validUntil).toBe(99)
    await wrapped.send({ address: ARK_ADDR, amount: 1_000 } as never)
    expect((calls[1]![0] as { selectedVtxos: unknown[] }).selectedVtxos).toHaveLength(1)
  })

  test('anything the selector does not model reaches the SDK untouched', async () => {
    const { calls, wrapped } = setup()
    const asset = { recipients: [{ address: ARK_ADDR, amount: 330, assets: [{ assetId: 'x', amount: 1n }] }] }
    const floor = { recipients: [{ address: ARK_ADDR, amount: 1_000 }], inputExpiryFloor: { kind: 'time', value: 1n } }
    const two = [{ address: ARK_ADDR, amount: 1_000 }, { address: ARK_ADDR, amount: 2_000 }]
    await wrapped.send(asset as never)
    await wrapped.send(floor as never)
    await wrapped.send(...(two as never[]))
    expect(calls[0]).toEqual([asset])
    expect(calls[1]).toEqual([floor])
    expect(calls[2]).toEqual(two)
  })

  test('other members are the wallet itself (this bound to the real wallet)', () => {
    expect(setup().wrapped.whoami()).toBe('raw')
  })
})
