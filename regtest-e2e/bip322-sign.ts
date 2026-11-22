// Drill helper: a throwaway regtest P2TR key and a BIP-322 (simple) key-path
// signature over a message — what an operator's own wallet does when the
// bridge's final send asks it to prove control of the destination. The
// to_spend/to_sign construction mirrors test/unit/dest_verify.test.ts.
//
//   bun regtest-e2e/bip322-sign.ts new                  → "<privhex> <bcrt1p…>"
//   bun regtest-e2e/bip322-sign.ts sign <privhex> <msg>  → base64 witness
import { schnorr } from '@noble/curves/secp256k1.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { base64, hex } from '@scure/base'
import { OutScript, p2tr, RawTx, RawWitness, Transaction, TEST_NETWORK } from '@scure/btc-signer'
import { sha256x2, taprootTweakPrivKey } from '@scure/btc-signer/utils.js'

const REGTEST = { ...TEST_NETWORK, bech32: 'bcrt' }

const [cmd, a, b] = process.argv.slice(2)
if (cmd === 'new') {
  const priv = randomBytes(32)
  console.log(`${hex.encode(priv)} ${p2tr(schnorr.getPublicKey(priv), undefined, REGTEST).address}`)
} else if (cmd === 'sign' && a && b !== undefined) {
  const priv = hex.decode(a)
  const script = OutScript.encode({ type: 'tr', pubkey: schnorr.getPublicKey(taprootTweakPrivKey(priv)) })
  const msgHash = schnorr.utils.taggedHash('BIP0322-signed-message', new TextEncoder().encode(b))
  const toSpendRaw = RawTx.encode({
    version: 0,
    segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: new Uint8Array([0x00, 0x20, ...msgHash]), sequence: 0 }],
    outputs: [{ amount: 0n, script }],
    witnesses: undefined,
    lockTime: 0,
  })
  const toSign = new Transaction({ version: 0, allowUnknownOutputs: true })
  toSign.addInput({ txid: sha256x2(toSpendRaw).reverse(), index: 0, sequence: 0 })
  toSign.addOutput({ script: new Uint8Array([0x6a]), amount: 0n })
  const sighash = toSign.preimageWitnessV1(0, [script], 0x00, [0n])
  console.log(base64.encode(RawWitness.encode([schnorr.sign(sighash, taprootTweakPrivKey(priv))])))
} else {
  console.error('usage: bip322-sign.ts new | sign <privhex> <message>')
  process.exit(2)
}
