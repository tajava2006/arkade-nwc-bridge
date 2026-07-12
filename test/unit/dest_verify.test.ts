import { describe, expect, test } from 'bun:test'
import { base64 } from '@scure/base'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import {
  OutScript,
  RawTx,
  RawWitness,
  Transaction,
  WIF,
  p2pkh,
  p2sh,
  p2tr,
  p2wpkh,
} from '@scure/btc-signer'
import {
  NETWORK,
  hash160,
  sha256x2,
  taprootTweakPrivKey,
} from '@scure/btc-signer/utils.js'
import { checkDestAddress, verifyDestSignature } from '../../src/exit/dest_verify'

// The BIP-322 spec's own P2WPKH test key: everything below is pinned to it.
const BIP322_P2WPKH = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'
const BIP322_P2TR = 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3'

describe('checkDestAddress', () => {
  test('accepts single-key mainnet types', () => {
    expect(checkDestAddress(BIP322_P2WPKH, NETWORK).ok).toBe(true)
    expect(checkDestAddress(BIP322_P2TR, NETWORK).ok).toBe(true)
    expect(checkDestAddress('1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', NETWORK).ok).toBe(true)
  })

  test('rejects p2wsh (script hash)', () => {
    const r = checkDestAddress(
      'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
      NETWORK,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('p2wsh')
  })

  test('rejects garbage and wrong-network addresses', () => {
    expect(checkDestAddress('nonsense', NETWORK).ok).toBe(false)
    expect(checkDestAddress('tb1q9vza2e8x573nczrlzms0wvx3gsqjx7vaxwd45v', NETWORK).ok).toBe(false)
  })
})

describe('verifyDestSignature — BIP-322 simple, spec vectors', () => {
  // Sanity: the pubkey inside the vector's witness stack really derives
  // both vector addresses — the P2WPKH and P2TR vectors share one key, so
  // this catches a mistyped address before we trust the signatures below.
  test('vector witness pubkey derives the vector addresses', () => {
    const stack = RawWitness.decode(
      base64.decode(
        'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=',
      ),
    )
    const pub = stack[1]!
    expect(p2wpkh(pub, NETWORK).address).toBe(BIP322_P2WPKH)
    expect(p2tr(pub.subarray(1), undefined, NETWORK).address).toBe(BIP322_P2TR)
  })

  test('P2WPKH, empty message', () => {
    const r = verifyDestSignature(
      BIP322_P2WPKH,
      '',
      'AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=',
      NETWORK,
    )
    expect(r).toEqual({ valid: true, scheme: 'bip322-simple' })
  })

  test('P2WPKH, "Hello World"', () => {
    const r = verifyDestSignature(
      BIP322_P2WPKH,
      'Hello World',
      'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=',
      NETWORK,
    )
    expect(r).toEqual({ valid: true, scheme: 'bip322-simple' })
  })

  test('P2WPKH vector rejected for a different message', () => {
    const r = verifyDestSignature(
      BIP322_P2WPKH,
      'Hello World!',
      'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=',
      NETWORK,
    )
    expect(r.valid).toBe(false)
  })
})

describe('verifyDestSignature — BIP-322 taproot key-path', () => {
  // Round-trip against a signer written here from the BIP-322 text (the
  // to_spend/to_sign construction is duplicated on purpose — it pins the
  // module's reading of the spec). Cross-implementation truth comes from
  // the fixed published vector below.
  function signTaproot(priv: Uint8Array, address: string, message: string): string {
    const script = OutScript.encode(
      { type: 'tr', pubkey: schnorrTweakedOutputKey(priv) },
    )
    const msgHash = schnorr.utils.taggedHash(
      'BIP0322-signed-message',
      new TextEncoder().encode(message),
    )
    const scriptSig = new Uint8Array([0x00, 0x20, ...msgHash])
    const toSpendRaw = RawTx.encode({
      version: 0,
      segwitFlag: false,
      inputs: [
        { txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: scriptSig, sequence: 0 },
      ],
      outputs: [{ amount: 0n, script }],
      witnesses: undefined,
      lockTime: 0,
    })
    const toSign = new Transaction({ version: 0, allowUnknownOutputs: true })
    toSign.addInput({ txid: sha256x2(toSpendRaw).reverse(), index: 0, sequence: 0 })
    toSign.addOutput({ script: new Uint8Array([0x6a]), amount: 0n })
    const sighash = toSign.preimageWitnessV1(0, [script], 0x00, [0n])
    const sig = schnorr.sign(sighash, taprootTweakPrivKey(priv))
    return base64.encode(RawWitness.encode([sig]))
  }

  function schnorrTweakedOutputKey(priv: Uint8Array): Uint8Array {
    return schnorr.getPublicKey(taprootTweakPrivKey(priv))
  }

  test('published bip322-js P2TR vector, "Hello World"', () => {
    const r = verifyDestSignature(
      BIP322_P2TR,
      'Hello World',
      'AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==',
      NETWORK,
    )
    expect(r).toEqual({ valid: true, scheme: 'bip322-simple' })
  })

  test('self-signed round trip on a fresh key', () => {
    const priv = new Uint8Array(32).fill(7)
    const pub = schnorr.getPublicKey(priv)
    const address = p2tr(pub, undefined, NETWORK).address!
    const sig = signTaproot(priv, address, 'challenge: deadbeef')
    expect(verifyDestSignature(address, 'challenge: deadbeef', sig, NETWORK)).toEqual({
      valid: true,
      scheme: 'bip322-simple',
    })
    // and the same signature must not validate a different challenge
    expect(verifyDestSignature(address, 'challenge: deadbeee', sig, NETWORK).valid).toBe(false)
  })

  test('rejects script-path style multi-item witness', () => {
    const r = verifyDestSignature(
      BIP322_P2TR,
      'Hello World',
      base64.encode(RawWitness.encode([new Uint8Array(64), new Uint8Array(34)])),
      NETWORK,
    )
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toContain('key-path')
  })
})

describe('verifyDestSignature — legacy scheme', () => {
  const MAGIC = new TextEncoder().encode('Bitcoin Signed Message:\n')
  function varstr(b: Uint8Array): Uint8Array {
    const out = new Uint8Array(1 + b.length)
    out[0] = b.length
    out.set(b, 1)
    return out
  }
  function legacySign(priv: Uint8Array, message: string): string {
    const msgHash = sha256x2(varstr(MAGIC), varstr(new TextEncoder().encode(message)))
    const compact = secp256k1.sign(msgHash, priv, { prehash: false, format: 'compact' })
    const pub = secp256k1.getPublicKey(priv, true)
    for (let recId = 0; recId < 4; recId++) {
      try {
        const recovered = secp256k1.Signature.fromBytes(compact, 'compact')
          .addRecoveryBit(recId)
          .recoverPublicKey(msgHash)
          .toBytes(true)
        if (recovered.every((v, i) => v === pub[i])) {
          const out = new Uint8Array(65)
          out[0] = 27 + recId + 4 // compressed-key header range
          out.set(compact, 1)
          return base64.encode(out)
        }
      } catch {}
    }
    throw new Error('no recovery id found')
  }

  const priv = new Uint8Array(32).fill(9)
  const pub = secp256k1.getPublicKey(priv, true)
  const challenge = 'arkade-exit final send to <addr> nonce 123'

  test('accepts for p2pkh / p2wpkh / p2sh-p2wpkh / p2tr of the same key', () => {
    const sig = legacySign(priv, challenge)
    const addrs = [
      p2pkh(pub, NETWORK).address!,
      p2wpkh(pub, NETWORK).address!,
      p2sh(p2wpkh(pub, NETWORK), NETWORK).address!,
      p2tr(pub.subarray(1), undefined, NETWORK).address!,
    ]
    for (const a of addrs) {
      expect(verifyDestSignature(a, challenge, sig, NETWORK)).toEqual({
        valid: true,
        scheme: 'legacy',
      })
    }
  })

  test('rejects for an address of a different key', () => {
    const sig = legacySign(priv, challenge)
    const otherPub = secp256k1.getPublicKey(new Uint8Array(32).fill(10), true)
    const r = verifyDestSignature(p2wpkh(otherPub, NETWORK).address!, challenge, sig, NETWORK)
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toContain('different key')
  })

  test('rejects a tampered message', () => {
    const sig = legacySign(priv, challenge)
    const r = verifyDestSignature(p2wpkh(pub, NETWORK).address!, challenge + 'x', sig, NETWORK)
    expect(r.valid).toBe(false)
  })

  test('rejects garbage base64 and out-of-range header', () => {
    const addr = p2wpkh(pub, NETWORK).address!
    expect(verifyDestSignature(addr, challenge, '!!notbase64!!', NETWORK).valid).toBe(false)
    const bad = new Uint8Array(65)
    bad[0] = 5
    expect(verifyDestSignature(addr, challenge, base64.encode(bad), NETWORK).valid).toBe(false)
  })
})

describe('verifyDestSignature — hardening', () => {
  test('OutScript sanity: tr program is bytes 2..34', () => {
    const dest = checkDestAddress(BIP322_P2TR, NETWORK)
    expect(dest.ok).toBe(true)
    if (dest.ok) {
      expect(dest.script.length).toBe(34)
      expect(dest.script[0]).toBe(0x51)
      expect(dest.script[1]).toBe(0x20)
    }
  })
})
