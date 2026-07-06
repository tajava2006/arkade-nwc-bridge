import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ChainTxType } from '@arkade-os/sdk'
import { openTempDb, type TempDb } from '../helpers/db'
import {
  renderStepperFragment,
  exitDetailView,
} from '../../src/web/views/exit_detail'
import type { ExitStepper } from '../../src/exit/stepper'
import type { ExitEstimate } from '../../src/exit/estimate'
import type { ExitOp } from '../../src/exit/ops'

// View-level tests: the action panel gates and cost/funding warnings are the
// point of #14, and they're pure rendering — driving them through the HTTP
// layer would need a full engine. The POST wiring itself is exercised by the
// engine's own sweep/startExit tests plus a manual regtest drill (#15).

const baseStepper = (over: Partial<ExitStepper> = {}): ExitStepper => ({
  txid: 'a'.repeat(64),
  vout: 0,
  valueSat: 10_000,
  op: null,
  proofComplete: true,
  steps: [
    { kind: 'broadcast', txid: 'c'.repeat(64), txType: ChainTxType.COMMITMENT, vsize: null, status: 'confirmed' },
    { kind: 'broadcast', txid: 'a'.repeat(64), txType: ChainTxType.ARK, vsize: 154, status: 'pending' },
    { kind: 'wait', status: 'pending', need: 0, have: 0, unit: 'blocks' },
    { kind: 'sweep', status: 'pending', destAddress: null, sweepTxid: null },
  ],
  probe: ['a'.repeat(64)],
  ...over,
})

const estimate = (over: Partial<ExitEstimate> = {}): ExitEstimate => ({
  txid: 'a'.repeat(64),
  vout: 0,
  valueSat: 10_000,
  txs: [{ txid: 'a'.repeat(64), type: ChainTxType.ARK, vsize: 154 }],
  packages: 1,
  parentVb: 154,
  childVb: 100,
  unrollVb: 254,
  sweepVb: 110,
  totalVb: 364,
  feeRateSatVb: 2,
  unrollFeeSat: 508,
  sweepFeeSat: 220,
  totalFeeSat: 728,
  feePctOfValue: 7,
  uneconomical: false,
  proofComplete: true,
  ...over,
})

const op = (state: ExitOp['state'], over: Partial<ExitOp> = {}): ExitOp => ({
  txid: 'a'.repeat(64),
  vout: 0,
  state,
  destAddress: null,
  sweepTxid: null,
  error: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

function render(stepper: ExitStepper, est: ExitEstimate | null, balanceSat: number | null): string {
  return exitDetailView({
    stepper,
    estimate: est,
    funding: { address: 'bc1pfuel', balanceSat },
    degraded: false,
  }).value
}

describe('exit controls (view)', () => {
  let temp: TempDb
  beforeEach(() => {
    temp = openTempDb()
  })
  afterEach(() => {
    temp.cleanup()
  })

  test('fresh vtxo: Start button + full cost line', () => {
    const html = render(baseStepper(), estimate(), 5_000)
    expect(html).toContain('Start exit')
    expect(html).toContain('/exit/' + 'a'.repeat(64) + '/0/start')
    expect(html).toContain('728 sats')
    expect(html).toContain('7% of value')
    expect(html).not.toContain('Sweep now')
  })

  test('incomplete proofs disable the Start button', () => {
    const html = render(baseStepper({ proofComplete: false }), estimate(), 5_000)
    expect(html).toContain('disabled')
    expect(html).toContain('proofs incomplete')
  })

  test('uneconomical exit carries the loses-money warning', () => {
    const html = render(
      baseStepper(),
      estimate({ uneconomical: true, totalFeeSat: 12_000, feePctOfValue: 120 }),
      5_000,
    )
    expect(html).toContain('exiting loses money')
    expect(html).toContain('120% of value')
  })

  test('sweepable op shows the Sweep button, not Start', () => {
    const stepper = baseStepper({
      op: op('sweepable'),
      steps: [
        { kind: 'broadcast', txid: 'a'.repeat(64), txType: ChainTxType.ARK, vsize: 154, status: 'confirmed' },
        { kind: 'wait', status: 'sweepable', need: 10, have: 10, unit: 'blocks' },
        { kind: 'sweep', status: 'sweepable', destAddress: null, sweepTxid: null },
      ],
    })
    const html = render(stepper, estimate(), 5_000)
    expect(html).toContain('Sweep now')
    expect(html).toContain('/0/sweep')
    expect(html).not.toContain('Start exit')
  })

  test('swept op shows the terminal message, no buttons', () => {
    const stepper = baseStepper({ op: op('swept', { destAddress: 'bc1pdest', sweepTxid: 'd'.repeat(64) }) })
    const html = render(stepper, estimate(), 5_000)
    expect(html).toContain('has left Ark')
    expect(html).not.toContain('Start exit')
    expect(html).not.toContain('Sweep now')
  })

  test('low exit fuel is flagged against the estimate', () => {
    const html = render(baseStepper(), estimate({ totalFeeSat: 728 }), 300)
    expect(html).toContain('Exit fuel is low')
    expect(html).toContain('300 sats on hand')
  })

  test('unknown fuel balance renders without a false low-fuel warning', () => {
    const html = render(baseStepper(), estimate(), null)
    expect(html).toContain('unknown (esplora unreachable)')
    expect(html).not.toContain('Exit fuel is low')
  })

  test('failed op offers Retry with the last error', () => {
    const stepper = baseStepper({ op: op('failed', { error: 'no proof for tx abc' }) })
    const html = render(stepper, estimate(), 5_000)
    expect(html).toContain('Retry exit')
    expect(html).toContain('no proof for tx abc')
  })

  test('stepper fragment counts completed steps', () => {
    const frag = renderStepperFragment(baseStepper()).value
    expect(frag).toContain('1/4 steps complete') // only the confirmed commitment
  })
})
