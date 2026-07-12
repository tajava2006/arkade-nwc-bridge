import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { base64 } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { OutScript, RawTx, RawWitness, Transaction, p2tr } from '@scure/btc-signer'
import { NETWORK, sha256x2, taprootTweakPrivKey, tagSchnorr } from '@scure/btc-signer/utils.js'
import {
  clearExitDest,
  getExitDest,
  issueDestChallenge,
  markDestSent,
  submitDestSignature,
} from '../../src/exit/dest'
import { openTempDb, type TempDb } from '../helpers/db'

// The challenge lifecycle around dest_verify: issue → sign (simulated
// taproot wallet) → verify → final-send bookkeeping. The signature math
// itself is covered in dest_verify.test.ts.

let tmp: TempDb
beforeEach(() => {
  tmp = openTempDb()
})
afterEach(() => tmp.cleanup())

const priv = new Uint8Array(32).fill(42)
const address = p2tr(schnorr.getPublicKey(priv), undefined, NETWORK).address!

/** a taproot wallet signing our challenge (BIP-322 simple, key-path) */
function signChallenge(challenge: string): string {
  const script = OutScript.encode({
    type: 'tr',
    pubkey: schnorr.getPublicKey(taprootTweakPrivKey(priv)),
  })
  const msgHash = tagSchnorr('BIP0322-signed-message', new TextEncoder().encode(challenge))
  const toSpendRaw = RawTx.encode({
    version: 0,
    segwitFlag: false,
    inputs: [
      {
        txid: new Uint8Array(32),
        index: 0xffffffff,
        finalScriptSig: new Uint8Array([0x00, 0x20, ...msgHash]),
        sequence: 0,
      },
    ],
    outputs: [{ amount: 0n, script }],
    witnesses: undefined,
    lockTime: 0,
  })
  const toSign = new Transaction({ version: 0, allowUnknownOutputs: true })
  toSign.addInput({ txid: sha256x2(toSpendRaw).reverse(), index: 0, sequence: 0 })
  toSign.addOutput({ script: new Uint8Array([0x6a]), amount: 0n })
  const sighash = toSign.preimageWitnessV1(0, [script], 0x00, [0n])
  return base64.encode(RawWitness.encode([schnorr.sign(sighash, taprootTweakPrivKey(priv))]))
}

describe('exit_dest lifecycle', () => {
  test('issue → challenge embeds the address and a nonce', () => {
    const r = issueDestChallenge(tmp.db, 'bitcoin', address)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dest.challenge).toContain(address)
    expect(r.dest.challenge).toContain('nonce')
    expect(r.dest.verifiedAt).toBeNull()
  })

  test('issue rejects invalid or script-hash addresses', () => {
    expect(issueDestChallenge(tmp.db, 'bitcoin', 'not-an-address').ok).toBe(false)
    expect(
      issueDestChallenge(
        tmp.db,
        'bitcoin',
        'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
      ).ok,
    ).toBe(false)
    expect(getExitDest(tmp.db)).toBeNull()
  })

  test('verify with a good signature marks the dest verified', () => {
    const issued = issueDestChallenge(tmp.db, 'bitcoin', address)
    if (!issued.ok) throw new Error('issue failed')
    const r = submitDestSignature(tmp.db, 'bitcoin', signChallenge(issued.dest.challenge))
    expect(r.ok).toBe(true)
    const dest = getExitDest(tmp.db)!
    expect(dest.verifiedAt).not.toBeNull()
    expect(dest.scheme).toBe('bip322-simple')
  })

  test('verify with a signature over a DIFFERENT challenge fails', () => {
    issueDestChallenge(tmp.db, 'bitcoin', address)
    const r = submitDestSignature(tmp.db, 'bitcoin', signChallenge('some other text'))
    expect(r.ok).toBe(false)
    expect(getExitDest(tmp.db)!.verifiedAt).toBeNull()
  })

  test('re-issuing voids a previous verification (new nonce)', () => {
    const first = issueDestChallenge(tmp.db, 'bitcoin', address)
    if (!first.ok) throw new Error('issue failed')
    submitDestSignature(tmp.db, 'bitcoin', signChallenge(first.dest.challenge))
    expect(getExitDest(tmp.db)!.verifiedAt).not.toBeNull()

    const second = issueDestChallenge(tmp.db, 'bitcoin', address)
    if (!second.ok) throw new Error('re-issue failed')
    expect(second.dest.verifiedAt).toBeNull()
    expect(second.dest.challenge).not.toBe(first.dest.challenge)
    // the old signature no longer verifies (nonce changed)
    const r = submitDestSignature(tmp.db, 'bitcoin', signChallenge(first.dest.challenge))
    expect(r.ok).toBe(false)
  })

  test('markDestSent records the txid; clear removes the row', () => {
    const issued = issueDestChallenge(tmp.db, 'bitcoin', address)
    if (!issued.ok) throw new Error('issue failed')
    submitDestSignature(tmp.db, 'bitcoin', signChallenge(issued.dest.challenge))
    markDestSent(tmp.db, 'f'.repeat(64))
    expect(getExitDest(tmp.db)!.sendTxid).toBe('f'.repeat(64))
    clearExitDest(tmp.db)
    expect(getExitDest(tmp.db)).toBeNull()
  })
})
