import type { ReceiveService } from './api/receive.ts'
import type { SendService } from './api/send.ts'
import type { Logger } from './log.ts'
import type { SwapStore } from './store.ts'

// The durable half of every swap path: on boot and every interval, walk the
// non-terminal rows and push each one forward from chain/LND state alone.
// The request handlers and the invoice subscription are only fast paths.
//
//  - send ln_inflight → resolveInflight (paid → claim, dead → failed; F6, F25)
//  - receive invoice_issued → fund a held invoice, or fail a cancelled one (F14)
//  - receive funded → harvest + settle (F1), or refund after MTP passes T (F2)
//  - receive refund_wait → cancel the hold invoice, terminalize (F16)
//  - then the float: renew coins near batch expiry, recover swept ones (float.ts)
//
// Every step takes the per-swap lock, so a pass never races a live request.

export interface ScannerDeps {
  store: SwapStore
  send: Pick<SendService, 'resolveInflight'>
  receive: Pick<ReceiveService, 'resumeInvoiceIssued' | 'resumeFunded' | 'resumeRefundWait'>
  medianTimePast: () => Promise<number>
  /** Float upkeep (float.ts), after the swaps; never throws. */
  float?: { pass(): Promise<unknown> }
  log: Logger
}

export class Scanner {
  private running = false
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private readonly d: ScannerDeps,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return
    void this.pass()
    this.timer = setInterval(() => void this.pass(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * One pass. Skipped while the previous one runs, so a slow pass cannot stack
   * work on top of itself (F13). One swap failing never stops the rest.
   * Resolves to false when it was skipped.
   */
  async pass(): Promise<boolean> {
    if (this.running) return false
    this.running = true
    try {
      const { store, send, receive, log } = this.d
      const mtp = await this.d.medianTimePast().catch((e: Error) => {
        log.warn(`scan: chain MTP unavailable, no refunds this pass: ${e.message}`)
        return undefined
      })
      const step = async (what: string, ids: string[], fn: (id: string) => Promise<unknown>) => {
        for (const id of ids) {
          try {
            await fn(id)
          } catch (e) {
            log.error(`scan: ${what} ${id}: ${(e as Error).message}`)
          }
        }
      }
      const ids = (dir: 'send' | 'receive', state: Parameters<SwapStore['list']>[1][number]) =>
        store.list(dir, [state]).map((s) => s.id)
      await step('send ln_inflight', ids('send', 'ln_inflight'), (id) => send.resolveInflight(id))
      await step('receive invoice_issued', ids('receive', 'invoice_issued'), (id) => receive.resumeInvoiceIssued(id))
      await step('receive funded', ids('receive', 'funded'), (id) => receive.resumeFunded(id, mtp))
      await step('receive refund_wait', ids('receive', 'refund_wait'), (id) => receive.resumeRefundWait(id))
      await this.d.float?.pass()
      return true
    } finally {
      this.running = false
    }
  }
}
