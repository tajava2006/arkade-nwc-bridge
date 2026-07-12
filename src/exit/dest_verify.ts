import { base64 } from '@scure/base'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { OP, Address, OutScript, RawTx, RawWitness, Transaction, p2tr } from '@scure/btc-signer'
import { hash160, sha256x2, tagSchnorr, type BTC_NETWORK } from '@scure/btc-signer/utils.js'

// Proof-of-control check for the final-send destination: before the exit
// engine sends everything to a user-supplied address, the user must sign a
// bridge-issued challenge with that address's key. A signature that
// verifies means the address can't be a typo or a clipboard swap — you
// can't sign for coins you don't hold the key to.
//
// Two schemes, because no single one covers real wallets:
// - BIP-322 "simple" (witness-stack signature over the virtual
//   to_spend/to_sign pair) — what Sparrow etc. produce for taproot and
//   native-segwit addresses.
// - Legacy "Bitcoin Signed Message" (65-byte compact recoverable ECDSA) —
//   what Electrum, hardware wallets and everything pre-BIP-322 produce.
//   Wallets disagree on the header-byte flag for segwit addresses, so we
//   ignore the flag's address-type hint and instead accept the signature
//   if the recovered key derives the target address under ANY supported
//   encoding (p2pkh, p2wpkh, p2sh-p2wpkh, or BIP-341-tweaked p2tr).
//
// Verification is deliberately strict everywhere else: sighash must be
// DEFAULT/ALL, taproot must be key-path, and script-hash targets we can't
// tie to a single key (p2wsh, unknown) are rejected up front — those are
// the "address is a script condition" cases the operator wants filtered.

export type DestCheck =
  | { ok: true; script: Uint8Array; type: 'pkh' | 'sh' | 'wpkh' | 'tr' }
  | { ok: false; reason: string }

export type VerifyResult =
  | { valid: true; scheme: 'bip322-simple' | 'legacy' }
  | { valid: false; reason: string }

const MESSAGE_MAGIC = new TextEncoder().encode('Bitcoin Signed Message:\n')
const SIGHASH_DEFAULT = 0x00
const SIGHASH_ALL = 0x01

/** compactSize(len) ‖ bytes — the varstr framing both message hashes use */
function varstr(data: Uint8Array): Uint8Array {
  if (data.length > 0xfc) throw new Error('challenge message too long')
  const out = new Uint8Array(1 + data.length)
  out[0] = data.length
  out.set(data, 1)
  return out
}

export function checkDestAddress(address: string, network: BTC_NETWORK): DestCheck {
  let decoded: ReturnType<ReturnType<typeof Address>['decode']>
  try {
    decoded = Address(network).decode(address.trim())
  } catch {
    return { ok: false, reason: 'not a valid Bitcoin address for this network' }
  }
  switch (decoded.type) {
    case 'pkh':
    case 'sh':
    case 'wpkh':
    case 'tr':
      return { ok: true, script: OutScript.encode(decoded), type: decoded.type }
    case 'wsh':
      return { ok: false, reason: 'p2wsh is a script hash — single-key addresses only' }
    default:
      return { ok: false, reason: `unsupported address type ${decoded.type}` }
  }
}

export function verifyDestSignature(
  address: string,
  message: string,
  signatureB64: string,
  network: BTC_NETWORK,
): VerifyResult {
  const dest = checkDestAddress(address, network)
  if (!dest.ok) return { valid: false, reason: dest.reason }

  let sig: Uint8Array
  try {
    sig = base64.decode(signatureB64.trim().replace(/\s+/g, ''))
  } catch {
    return { valid: false, reason: 'signature is not valid base64' }
  }

  // 65 bytes is exactly a legacy compact signature; every BIP-322 simple
  // witness stack is a different length (66 for taproot, ~107 for segwit).
  if (sig.length === 65) return verifyLegacy(dest, sig, message, network)
  return verifyBip322Simple(dest, sig, message)
}

function verifyLegacy(
  dest: Extract<DestCheck, { ok: true }>,
  sig: Uint8Array,
  message: string,
  network: BTC_NETWORK,
): VerifyResult {
  const header = sig[0]!
  if (header < 27 || header > 42) {
    return { valid: false, reason: `legacy signature header byte ${header} out of range` }
  }
  const msgHash = sha256x2(varstr(MESSAGE_MAGIC), varstr(new TextEncoder().encode(message)))

  let pubkey: Uint8Array // compressed
  let pubkeyUncompressed: Uint8Array
  try {
    const point = secp256k1.Signature.fromBytes(sig.subarray(1), 'compact')
      .addRecoveryBit((header - 27) & 3)
      .recoverPublicKey(msgHash)
    pubkey = point.toBytes(true)
    pubkeyUncompressed = point.toBytes(false)
  } catch {
    return { valid: false, reason: 'signature does not recover a public key' }
  }

  const wpkhScript = OutScript.encode({ type: 'wpkh', hash: hash160(pubkey) })
  const candidates = [
    OutScript.encode({ type: 'pkh', hash: hash160(pubkey) }),
    OutScript.encode({ type: 'pkh', hash: hash160(pubkeyUncompressed) }),
    wpkhScript,
    OutScript.encode({ type: 'sh', hash: hash160(wpkhScript) }),
    p2tr(pubkey.subarray(1), undefined, network).script,
  ]
  if (candidates.some((c) => bytesEqual(c, dest.script))) {
    return { valid: true, scheme: 'legacy' }
  }
  return { valid: false, reason: 'signature is valid but was made by a different key/address' }
}

function verifyBip322Simple(
  dest: Extract<DestCheck, { ok: true }>,
  sig: Uint8Array,
  message: string,
): VerifyResult {
  if (dest.type === 'pkh') {
    return { valid: false, reason: 'legacy p2pkh addresses need a legacy (65-byte) signature' }
  }

  let stack: Uint8Array[]
  try {
    stack = RawWitness.decode(sig)
  } catch {
    return { valid: false, reason: 'signature is neither legacy nor a BIP-322 witness stack' }
  }

  // Virtual to_spend tx fixed by BIP-322: spends the tagged message hash
  // into the target script. Its txid is all the signature commits to.
  const msgHash = tagSchnorr('BIP0322-signed-message', new TextEncoder().encode(message))
  const scriptSig = new Uint8Array(2 + 32)
  scriptSig[0] = OP.OP_0
  scriptSig[1] = 0x20
  scriptSig.set(msgHash, 2)
  const toSpendRaw = RawTx.encode({
    version: 0,
    segwitFlag: false,
    inputs: [
      { txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: scriptSig, sequence: 0 },
    ],
    outputs: [{ amount: 0n, script: dest.script }],
    witnesses: undefined,
    lockTime: 0,
  })
  const toSpendTxid = sha256x2(toSpendRaw).reverse() // display order, as addInput expects

  const toSign = new Transaction({ version: 0, allowUnknownOutputs: true })
  toSign.addInput({ txid: toSpendTxid, index: 0, sequence: 0 })
  toSign.addOutput({ script: new Uint8Array([OP.RETURN]), amount: 0n })

  if (dest.type === 'tr') {
    if (stack.length !== 1) {
      return { valid: false, reason: 'taproot BIP-322 must be a key-path signature (1 witness item)' }
    }
    const raw = stack[0]!
    let hashType = SIGHASH_DEFAULT
    if (raw.length === 65) hashType = raw[64]!
    else if (raw.length !== 64) {
      return { valid: false, reason: `schnorr signature must be 64 or 65 bytes, got ${raw.length}` }
    }
    if (hashType !== SIGHASH_DEFAULT && hashType !== SIGHASH_ALL) {
      return { valid: false, reason: 'only SIGHASH_DEFAULT/ALL accepted' }
    }
    const sighash = toSign.preimageWitnessV1(0, [dest.script], hashType, [0n])
    const outputKey = dest.script.subarray(2) // 0x51 0x20 <32-byte output key>
    const ok = schnorr.verify(raw.subarray(0, 64), sighash, outputKey)
    return ok
      ? { valid: true, scheme: 'bip322-simple' }
      : { valid: false, reason: 'schnorr signature does not verify for this address' }
  }

  // wpkh / sh(p2wpkh): witness is [DER sig ‖ hashtype, compressed pubkey]
  if (stack.length !== 2) {
    return { valid: false, reason: 'segwit BIP-322 witness must be [signature, pubkey]' }
  }
  const derSig = stack[0]!
  const pubkey = stack[1]!
  if (pubkey.length !== 33) {
    return { valid: false, reason: 'pubkey in witness must be 33-byte compressed' }
  }
  const pubHash = hash160(pubkey)
  if (dest.type === 'wpkh') {
    if (!bytesEqual(pubHash, dest.script.subarray(2))) {
      return { valid: false, reason: 'pubkey in witness does not match the address' }
    }
  } else {
    // sh: only sh(p2wpkh) is verifiable from [sig, pub]
    const redeem = OutScript.encode({ type: 'wpkh', hash: pubHash })
    if (!bytesEqual(hash160(redeem), dest.script.subarray(2, 22))) {
      return { valid: false, reason: 'pubkey does not match this p2sh address (only p2sh-p2wpkh supported)' }
    }
  }
  if (derSig.length < 9) return { valid: false, reason: 'DER signature too short' }
  const hashType = derSig[derSig.length - 1]!
  if (hashType !== SIGHASH_ALL) {
    return { valid: false, reason: 'only SIGHASH_ALL accepted' }
  }
  // BIP-143 script code for p2wpkh spends is the p2pkh script of the key hash
  const scriptCode = OutScript.encode({ type: 'pkh', hash: pubHash })
  const sighash = toSign.preimageWitnessV0(0, scriptCode, hashType, 0n)
  let ok: boolean
  try {
    ok = secp256k1.verify(derSig.subarray(0, -1), sighash, pubkey, {
      prehash: false,
      format: 'der',
    })
  } catch {
    ok = false
  }
  return ok
    ? { valid: true, scheme: 'bip322-simple' }
    : { valid: false, reason: 'ECDSA signature does not verify for this address' }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
