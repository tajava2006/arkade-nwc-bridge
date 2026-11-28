import { describe, expect, test } from 'bun:test'
import {
  SUBDUST_SEND_CLTV_BUFFER_BLOCKS,
  SUBDUST_SEND_MIN_WINDOW_SECS,
  maxCltvBlocks,
  sendWindowSecs,
  type SendWindowConfig,
} from '../../subdustd/send_window.ts'

// Per-invoice T sizing (ATOMIC_SUBDUST_PLAN.md §12). T is simultaneously the
// funder's worst-case lock AND the LN cltv budget, so the only safe direction
// for an unknown answer is the full configured window.

const cfg: SendWindowConfig = {
  sendWindow: 259_200, // 72h, the mainnet ceiling
  payMargin: 600,
  blockTime: 600,
}

describe('sendWindowSecs', () => {
  test('a measured route shortens T well below the ceiling', () => {
    // 150-block route + 36 buffer = 186 blocks ≈ 31h — under half the ceiling.
    const w = sendWindowSecs(150, cfg)
    expect(w).toBe((150 + SUBDUST_SEND_CLTV_BUFFER_BLOCKS) * 600 + 600)
    expect(w).toBeLessThan(cfg.sendWindow)
  })

  test('the buffer is actually applied (a route sized exactly to T would not pay)', () => {
    expect(sendWindowSecs(100, cfg)).toBeGreaterThan(100 * cfg.blockTime + cfg.payMargin)
  })

  test('never exceeds the configured ceiling, however long the route', () => {
    expect(sendWindowSecs(10_000, cfg)).toBe(cfg.sendWindow)
    expect(sendWindowSecs(Number.MAX_SAFE_INTEGER, cfg)).toBe(cfg.sendWindow)
  })

  test('never drops below the floor', () => {
    expect(sendWindowSecs(1, cfg)).toBeGreaterThanOrEqual(SUBDUST_SEND_MIN_WINDOW_SECS)
  })

  test('unknown / nonsense route ⇒ the FULL window (old behaviour, never a gate)', () => {
    // undefined covers all of: no route found, LND unreachable, query threw.
    // Refusing the swap here would reject sends on an LND hiccup, because the
    // query cannot distinguish "no route" from "could not ask".
    for (const delta of [undefined, 0, -1, -10_000]) {
      expect(sendWindowSecs(delta, cfg)).toBe(cfg.sendWindow)
    }
  })

  test('a shortened T still leaves a usable cltv budget for the route it was sized to', () => {
    // sendFund derives cltvLimit = (T − payMargin) / blockTime; by construction
    // that must stay ≥ the route we measured, or the pay we sized for fails.
    const route = 120
    const w = sendWindowSecs(route, cfg)
    const budget = Math.floor((w - cfg.payMargin) / cfg.blockTime)
    expect(budget).toBeGreaterThanOrEqual(route)
  })
})

describe('maxCltvBlocks', () => {
  test('mirrors sendFund’s cltvLimit at the maximum T', () => {
    expect(maxCltvBlocks(cfg)).toBe(Math.floor((259_200 - 600) / 600))
  })

  test('stays positive even under a degenerate config', () => {
    expect(maxCltvBlocks({ sendWindow: 60, payMargin: 600, blockTime: 600 })).toBe(1)
  })
})
