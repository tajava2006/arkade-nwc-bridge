import { describe, expect, test } from 'bun:test'
import type { ArkAddress } from '@arkade-os/sdk'
import { SubdustEdgeError, computeClaimSplit } from '../../src/atomic/split'

// Fake addresses: the calculator only reads pkScript / subdustPkScript, so tag
// each with recognizable bytes to assert which script (regular vs OP_RETURN)
// each output used. 0x51 20 … = P2TR-ish; 0x6a 20 … = OP_RETURN-ish.
function mkAddr(tag: number): ArkAddress {
  return {
    pkScript: Uint8Array.from([0x51, 0x20, ...Array(32).fill(tag)]),
    subdustPkScript: Uint8Array.from([0x6a, 0x20, ...Array(32).fill(tag + 1)]),
  } as unknown as ArkAddress
}
const funder = mkAddr(0xf0)
const claimer = mkAddr(0xc0)
const DUST = 330

const sum = (outs: { amount: bigint }[]) => outs.reduce((s, o) => s + o.amount, 0n)

describe('computeClaimSplit', () => {
  test('regular change: a sub-dust to claimer, V−a regular to funder (1 OP_RETURN)', () => {
    const r = computeClaimSplit({ funderAddress: funder, claimerAddress: claimer, fundingValue: 1000, amount: 21, dust: DUST })
    expect(r.claimerAmount).toBe(21n)
    expect(r.changeAmount).toBe(979n)
    expect(r.changeKind).toBe('regular')
    expect(r.opReturns).toBe(1)
    expect(r.outputs).toHaveLength(2)
    expect(r.outputs[0]!.script).toEqual(claimer.subdustPkScript) // a → OP_RETURN
    expect(r.outputs[1]!.script).toEqual(funder.pkScript) // change → regular
    expect(sum(r.outputs)).toBe(1000n) // outputs sum to V
  })

  test('sub-dust change: both a and change OP_RETURN (2 OP_RETURN edge)', () => {
    const r = computeClaimSplit({ funderAddress: funder, claimerAddress: claimer, fundingValue: 400, amount: 200, dust: DUST })
    expect(r.changeAmount).toBe(200n)
    expect(r.changeKind).toBe('subdust')
    expect(r.opReturns).toBe(2)
    expect(r.outputs[1]!.script).toEqual(funder.subdustPkScript)
    expect(sum(r.outputs)).toBe(400n)
  })

  test('omitted change: fee consumes the remainder (V = a + fee)', () => {
    const r = computeClaimSplit({
      funderAddress: funder,
      claimerAddress: claimer,
      fundingValue: 531,
      amount: 200,
      dust: DUST,
      feeSats: 331, // ≥ dust → regular fee output
      feeRecipient: mkAddr(0xe0),
    })
    expect(r.changeAmount).toBe(0n)
    expect(r.changeKind).toBe('omitted')
    expect(r.feeAmount).toBe(331n)
    expect(r.outputs).toHaveLength(2) // claimer + fee, no change
    expect(sum(r.outputs)).toBe(531n)
  })

  test('fee > 0 without a recipient is rejected', () => {
    expect(() =>
      computeClaimSplit({ funderAddress: funder, claimerAddress: claimer, fundingValue: 1000, amount: 21, dust: DUST, feeSats: 5 }),
    ).toThrow(SubdustEdgeError)
  })

  test('rejects a ≥ dust and a + fee > V', () => {
    expect(() => computeClaimSplit({ funderAddress: funder, claimerAddress: claimer, fundingValue: 1000, amount: 330, dust: DUST })).toThrow(
      SubdustEdgeError,
    )
    expect(() => computeClaimSplit({ funderAddress: funder, claimerAddress: claimer, fundingValue: 100, amount: 200, dust: DUST })).toThrow(
      /exceeds funding value/,
    )
  })

  test('rejects when the split would exceed the server OP_RETURN cap', () => {
    // 2-OP_RETURN split against a cap of 1 → the U−a<dust edge arkd would refuse.
    expect(() =>
      computeClaimSplit({
        funderAddress: funder,
        claimerAddress: claimer,
        fundingValue: 400,
        amount: 200,
        dust: DUST,
        maxOpReturnOutputs: 1,
      }),
    ).toThrow(/SUBDUST_EDGE_REJECTED/)
  })
})
