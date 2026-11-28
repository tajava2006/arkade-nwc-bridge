import { describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { base64, hex } from '@scure/base'
import { ConditionWitness, Transaction, setArkPsbtField } from '@arkade-os/sdk'
import { extractPreimageFromClaim } from '../../subdustd/preimage.ts'

// F1 (SUBDUST_ATOMIC_SECURITY_REVIEW.md): the server must recover the LN preimage
// from the receiver's on-chain claim of the shared vtxo, never trusting the
// receiver to hand it over. These tests pin the extraction: hash-verified,
// txid-keyed, outpoint-matched, decoy-resistant.

const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest()

/**
 * Build a claim-like PSBT: one input spending `outpointTxidHex:vout`, carrying
 * `witnessItems` in the ConditionWitness ark field. Returns the base64 PSBT, its
 * decoded txid, and the input's txid AS THE EXTRACTOR SEES IT (hex of
 * getInput().txid) — so the test is robust to btc-signer's internal byte order.
 */
function buildClaim(
  outpointTxidHex: string,
  vout: number,
  witnessItems: Uint8Array[],
): { psbt: string; txid: string; inputTxidHex: string } {
  const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true })
  tx.addInput({ txid: hex.decode(outpointTxidHex), index: vout })
  tx.addOutput({ script: hex.decode(`0014${'00'.repeat(20)}`), amount: 1000n })
  setArkPsbtField(tx, 0, ConditionWitness, witnessItems)
  const inp = tx.getInput(0)
  return { psbt: base64.encode(tx.toPSBT()), txid: tx.id, inputTxidHex: hex.encode(inp.txid!) }
}

describe('extractPreimageFromClaim', () => {
  const vout = 0
  const seedTxid = hex.encode(randomBytes(32))

  test('returns the preimage when ConditionWitness carries it and the hash matches', () => {
    const preimage = randomBytes(32)
    const H = sha256(preimage)
    const { psbt, txid, inputTxidHex } = buildClaim(seedTxid, vout, [preimage])

    const got = extractPreimageFromClaim([psbt], txid, { txid: inputTxidHex, vout }, H)

    expect(got).toBeDefined()
    expect(hex.encode(got!)).toEqual(hex.encode(preimage))
  })

  test('rejects when the hash does not match (a different invoice)', () => {
    const preimage = randomBytes(32)
    const wrongH = sha256(randomBytes(32))
    const { psbt, txid, inputTxidHex } = buildClaim(seedTxid, vout, [preimage])

    expect(
      extractPreimageFromClaim([psbt], txid, { txid: inputTxidHex, vout }, wrongH),
    ).toBeUndefined()
  })

  test('rejects witness items that are not the preimage (short + 32B decoy)', () => {
    const preimage = randomBytes(32)
    const H = sha256(preimage)
    const { psbt, txid, inputTxidHex } = buildClaim(seedTxid, vout, [
      randomBytes(16), // wrong length
      randomBytes(32), // 32B but sha256(decoy) != H
    ])

    expect(
      extractPreimageFromClaim([psbt], txid, { txid: inputTxidHex, vout }, H),
    ).toBeUndefined()
  })

  test('ignores a served tx whose decoded txid is not the requested spentBy (wrong label)', () => {
    const preimage = randomBytes(32)
    const H = sha256(preimage)
    const { psbt, inputTxidHex } = buildClaim(seedTxid, vout, [preimage])
    const wrongSpentBy = hex.encode(randomBytes(32))

    expect(
      extractPreimageFromClaim([psbt], wrongSpentBy, { txid: inputTxidHex, vout }, H),
    ).toBeUndefined()
  })

  test('rejects when no input spends the shared outpoint', () => {
    const preimage = randomBytes(32)
    const H = sha256(preimage)
    const { psbt, txid } = buildClaim(seedTxid, vout, [preimage])
    const otherOutpoint = hex.encode(randomBytes(32))

    expect(
      extractPreimageFromClaim([psbt], txid, { txid: otherOutpoint, vout }, H),
    ).toBeUndefined()
  })

  test('finds the matching claim among several served txs', () => {
    const preimage = randomBytes(32)
    const H = sha256(preimage)
    const decoy = buildClaim(hex.encode(randomBytes(32)), 1, [randomBytes(32)])
    const real = buildClaim(seedTxid, vout, [preimage])

    const got = extractPreimageFromClaim(
      [decoy.psbt, real.psbt],
      real.txid,
      { txid: real.inputTxidHex, vout },
      H,
    )

    expect(got).toBeDefined()
    expect(hex.encode(got!)).toEqual(hex.encode(preimage))
  })
})
