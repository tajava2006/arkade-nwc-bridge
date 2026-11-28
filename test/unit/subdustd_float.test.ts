import { describe, expect, test } from 'bun:test'
import { FloatLock, FloatRenewer, shapePlan } from '../../subdustd/float'

const ctx = (subtotal: number, over: { fee?: number; assets?: boolean } = {}) => ({
  subtotal: BigInt(subtotal),
  dust: 330n,
  outputFeeOn: () => BigInt(over.fee ?? 0),
  hasAssets: over.assets ?? false,
})
const silent = { debug() {}, info() {}, warn() {}, error() {} } as never

describe('shapePlan — a renewal keeps the float shape', () => {
  test('one output per coin at its own value (receives spend whole coins)', () => {
    expect(shapePlan([2000, 100_000, 2000], ctx(104_000), 16)).toEqual([100_000n, 2000n, 2000n])
  })

  test('sub-dust value and fee differences fold into the largest piece', () => {
    expect(shapePlan([5000, 7, 2000], ctx(7007), 16)).toEqual([5007n, 2000n])
    expect(shapePlan([5000, 2000], ctx(7000, { fee: 10 }), 16)).toEqual([4980n, 2000n])
  })

  test('past maxOutputs the smallest pieces merge; the sum always matches', () => {
    const p = shapePlan([1000, 1000, 1000, 1000], ctx(4000), 2)
    expect(p).toHaveLength(2)
    expect(p.reduce((a, b) => a + b, 0n)).toBe(4000n)
    expect(p.every((x) => x >= 330n)).toBe(true)
  })

  test('assets or nothing above dust: one piece', () => {
    expect(shapePlan([5000, 2000], ctx(7000, { assets: true }), 16)).toEqual([7000n])
    expect(shapePlan([100, 200], ctx(300), 16)).toEqual([300n])
  })
})

describe('FloatLock', () => {
  test('runs one picker at a time, in order, and survives a throw', async () => {
    const lock = new FloatLock()
    const order: string[] = []
    const slow = lock.run(async () => {
      order.push('a+')
      await Bun.sleep(20)
      order.push('a-')
    })
    const failing = lock.run(async () => {
      order.push('b')
      throw new Error('boom')
    })
    const after = lock.run(async () => order.push('c'))
    await slow
    await expect(failing).rejects.toThrow('boom')
    await after
    expect(order).toEqual(['a+', 'a-', 'b', 'c'])
  })
})

describe('FloatRenewer', () => {
  test('renews due coins under the lock with the shape plan; idle when nothing is due', async () => {
    const calls: { threshold?: number; plan?: bigint[] }[] = []
    let due = [{ value: 100_000 }, { value: 2000 }]
    const manager = {
      getExpiringVtxos: async () => due as never,
      renewVtxos: async (_cb: undefined, o?: { thresholdSeconds?: number; split?: { plan(c: never): readonly bigint[] } }) => {
        calls.push({ threshold: o?.thresholdSeconds, plan: [...o!.split!.plan(ctx(102_000) as never)] })
        return 'round-1'
      },
      recoverVtxos: async () => {
        throw new Error('No recoverable VTXOs found')
      },
    }
    const r = new FloatRenewer({ manager, lock: new FloatLock(), thresholdSecs: 1320, log: silent })
    expect(await r.pass()).toEqual({ renewed: 'round-1' })
    expect(calls).toEqual([{ threshold: 1320, plan: [100_000n, 2000n] }])
    due = []
    expect(await r.pass()).toEqual({})
    expect(calls).toHaveLength(1)
  })

  test('a failing renewal never throws out of the pass (the swap scan must go on)', async () => {
    const manager = {
      getExpiringVtxos: async () => {
        throw new Error('arkd down')
      },
      renewVtxos: async () => 'x',
      recoverVtxos: async () => {
        throw new Error('arkd down')
      },
    }
    const r = new FloatRenewer({ manager, lock: new FloatLock(), thresholdSecs: 10, log: silent })
    expect(await r.pass()).toEqual({})
  })

  test('only sub-dust due is not a failure: no warning, retried silently', async () => {
    const warns: string[] = []
    const log = { debug() {}, info() {}, warn: (m: string) => warns.push(m), error() {} } as never
    const manager = {
      getExpiringVtxos: async () => [{ value: 44 }] as never,
      renewVtxos: async () => {
        throw new Error('Total amount 44 is below dust threshold 330')
      },
      recoverVtxos: async () => {
        throw new Error('No recoverable VTXOs found')
      },
    }
    expect(await new FloatRenewer({ manager, lock: new FloatLock(), thresholdSecs: 10, log }).pass()).toEqual({})
    expect(warns).toEqual([])
  })
})
