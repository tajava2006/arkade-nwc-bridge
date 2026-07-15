import { describe, expect, test } from 'bun:test'
import { hex } from '@scure/base'
import {
  SwapDirection,
  rolesForDirection,
  validateSwapParams,
  type AtomicSwapParams,
} from '../../src/atomic/params'

const USER = hex.decode('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
const BOLTZ = hex.decode('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5')
const SERVER = hex.decode('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9')

function params(overrides: Partial<AtomicSwapParams> = {}): AtomicSwapParams {
  return {
    direction: SwapDirection.Send,
    amount: 21,
    paymentHash: new Uint8Array(32).fill(0xab),
    refundLocktime: 1893456000n,
    exitDelay: 512n,
    funder: USER,
    claimer: BOLTZ,
    server: SERVER,
    fundingValue: 1000,
    dust: 330,
    vtxoMin: 1,
    ...overrides,
  }
}

describe('rolesForDirection', () => {
  test('send folds user→boltz (F=user, C=boltz)', () => {
    expect(rolesForDirection(SwapDirection.Send, USER, BOLTZ)).toEqual({ funder: USER, claimer: BOLTZ })
  })
  test('receive folds boltz→user (F=boltz, C=user)', () => {
    expect(rolesForDirection(SwapDirection.Receive, USER, BOLTZ)).toEqual({ funder: BOLTZ, claimer: USER })
  })
})

describe('validateSwapParams', () => {
  test('accepts a well-formed sub-dust swap', () => {
    expect(validateSwapParams(params())).toEqual({ ok: true })
  })

  test('rejects a below vtxoMin (cannot become a recoverable vtxo)', () => {
    const r = validateSwapParams(params({ amount: 1, vtxoMin: 10 }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/vtxoMinAmount/)
  })

  test('rejects a ≥ dust (belongs on the regular VHTLC path)', () => {
    const r = validateSwapParams(params({ amount: 330, dust: 330 }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/regular VHTLC/)
  })

  test('rejects a sub-dust funding vtxo', () => {
    expect(validateSwapParams(params({ fundingValue: 300, dust: 330 })).ok).toBe(false)
  })

  test('rejects when a + fee exceeds V', () => {
    const r = validateSwapParams(params({ amount: 300, feeSats: 800, fundingValue: 1000 }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/exceeds fundingValue/)
  })

  test('rejects bad key length, bad payment hash, non-positive T/d', () => {
    expect(validateSwapParams(params({ funder: new Uint8Array(31) })).ok).toBe(false)
    expect(validateSwapParams(params({ paymentHash: new Uint8Array(20) })).ok).toBe(false)
    expect(validateSwapParams(params({ refundLocktime: 0n })).ok).toBe(false)
    expect(validateSwapParams(params({ exitDelay: 0n })).ok).toBe(false)
  })

  test('accepts the boundary a = dust − 1 and a = vtxoMin', () => {
    expect(validateSwapParams(params({ amount: 329, dust: 330 })).ok).toBe(true)
    expect(validateSwapParams(params({ amount: 1, vtxoMin: 1 })).ok).toBe(true)
  })
})
