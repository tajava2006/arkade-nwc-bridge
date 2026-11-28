import { describe, expect, test } from 'bun:test'
import { Scanner } from '../../subdustd/scanner.ts'
import { createLogger } from '../../subdustd/log.ts'
import { SwapStore, type NewSwap } from '../../subdustd/store.ts'

const row = (id: string, direction: 'send' | 'receive', n: number): NewSwap => ({
  id,
  direction,
  paymentHash: n.toString(16).padStart(64, '0'),
  amount: 21,
  refundLocktime: 1_900_000_000,
  userPubkey: 'aa'.repeat(32),
})

const seeded = () => {
  const store = SwapStore.open(':memory:')
  store.create(row('s1', 'send', 1))
  store.transition('s1', 'init', 'funded')
  store.transition('s1', 'funded', 'ln_inflight')
  store.create(row('r1', 'receive', 2)) // invoice_issued
  store.create(row('r2', 'receive', 3))
  store.transition('r2', 'invoice_issued', 'funded')
  store.create(row('r3', 'receive', 4))
  store.transition('r3', 'invoice_issued', 'funded')
  store.transition('r3', 'funded', 'refund_wait')
  store.create(row('s2', 'send', 5)) // init: nothing to resume
  return store
}

const quiet = createLogger('error', () => {})

describe('Scanner', () => {
  test('walks every non-terminal row once, with the chain MTP for funded receives', async () => {
    const calls: string[] = []
    const scanner = new Scanner({
      store: seeded(),
      send: { resolveInflight: async (id) => (calls.push(`send:${id}`), undefined) },
      receive: {
        resumeInvoiceIssued: async (id) => void calls.push(`issued:${id}`),
        resumeFunded: async (id, mtp) => void calls.push(`funded:${id}@${mtp}`),
        resumeRefundWait: async (id) => void calls.push(`refund_wait:${id}`),
      },
      medianTimePast: async () => 1_800_000_000,
      log: quiet,
    })
    expect(await scanner.pass()).toBe(true)
    expect(calls).toEqual(['send:s1', 'issued:r1', 'funded:r2@1800000000', 'refund_wait:r3'])
  })

  test('an unknown MTP still runs the pass but hands funded receives no clock (no refunds)', async () => {
    const seen: (number | undefined)[] = []
    const scanner = new Scanner({
      store: seeded(),
      send: { resolveInflight: async () => undefined },
      receive: { resumeInvoiceIssued: async () => {}, resumeFunded: async (_id, mtp) => void seen.push(mtp), resumeRefundWait: async () => {} },
      medianTimePast: async () => {
        throw new Error('lnd down')
      },
      log: quiet,
    })
    await scanner.pass()
    expect(seen).toEqual([undefined])
  })

  test('one failing swap does not stop the rest', async () => {
    const calls: string[] = []
    const scanner = new Scanner({
      store: seeded(),
      send: {
        resolveInflight: async () => {
          throw new Error('arkd down')
        },
      },
      receive: {
        resumeInvoiceIssued: async (id) => void calls.push(id),
        resumeFunded: async (id) => void calls.push(id),
        resumeRefundWait: async (id) => void calls.push(id),
      },
      medianTimePast: async () => 0,
      log: quiet,
    })
    await scanner.pass()
    expect(calls).toEqual(['r1', 'r2', 'r3'])
  })

  test('a pass that outruns the interval is not stacked (F13)', async () => {
    let releaseFirst!: () => void
    let inflight = 0
    let maxInflight = 0
    const scanner = new Scanner({
      store: seeded(),
      send: {
        resolveInflight: () =>
          new Promise((r) => {
            inflight++
            maxInflight = Math.max(maxInflight, inflight)
            releaseFirst = () => {
              inflight--
              r(undefined)
            }
          }),
      },
      receive: { resumeInvoiceIssued: async () => {}, resumeFunded: async () => {}, resumeRefundWait: async () => {} },
      medianTimePast: async () => 0,
      log: quiet,
    })
    const first = scanner.pass()
    await Bun.sleep(5)
    expect(await scanner.pass()).toBe(false)
    releaseFirst()
    expect(await first).toBe(true)
    expect(maxInflight).toBe(1)
  })
})
