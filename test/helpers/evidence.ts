import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { Script, TAPROOT_UNSPENDABLE_KEY, Transaction, p2tr } from '@scure/btc-signer'

// Spend-evidence fixture: a taproot SCRIPT-PATH spend of a given outpoint,
// signed by "our" key — the exact artifact arkd's indexer serves as spentBy
// (spike: test/spike/spend_evidence.spike.ts). Unlike helpers/exit.ts (key
// spend), evidence verification only ever sees script-path spends, so the
// tapscript here is the minimal <pub> OP_CHECKSIG leaf.

export interface SpendEvidenceFixture {
  /** x-only pubkey the spend is signed with */
  pubkey: Uint8Array
  /** signed-but-not-finalized PSBT (tapScriptSig labelled), as arkd serves */
  psbtB64: string
  /** same spend finalized: witness stack only, no labelled fields */
  finalizedPsbtB64: string
  /** txid of the spending tx */
  spendTxid: string
}

export function makeSpendEvidence(
  privSeed: number,
  outpoint: { txid: string; vout: number },
  opts: { amount?: bigint; extraInput?: { txid: string; vout: number } } = {},
): SpendEvidenceFixture {
  const priv = new Uint8Array(32).fill(privSeed)
  const pubkey = schnorr.getPublicKey(priv)
  const amount = opts.amount ?? 10_000n
  const payment = p2tr(
    TAPROOT_UNSPENDABLE_KEY,
    { script: Script.encode([pubkey, 'CHECKSIG']) },
    undefined,
    true,
  )

  const build = () => {
    const tx = new Transaction({ allowUnknownOutputs: true })
    tx.addInput({
      txid: outpoint.txid,
      index: outpoint.vout,
      witnessUtxo: { script: payment.script, amount },
      tapLeafScript: payment.tapLeafScript,
    })
    if (opts.extraInput) {
      tx.addInput({
        txid: opts.extraInput.txid,
        index: opts.extraInput.vout,
        witnessUtxo: { script: payment.script, amount },
        tapLeafScript: payment.tapLeafScript,
      })
    }
    tx.addOutput({ script: payment.script, amount })
    tx.signIdx(priv, 0)
    if (opts.extraInput) tx.signIdx(priv, 1)
    return tx
  }

  const signed = build()
  const psbtB64 = base64.encode(signed.toPSBT())

  const finalized = build()
  finalized.finalize()
  const finalizedPsbtB64 = base64.encode(finalized.toPSBT())

  return { pubkey, psbtB64, finalizedPsbtB64, spendTxid: signed.id }
}

/** A random-looking but deterministic fake txid. */
export function fakeTxid(seed: number): string {
  return hex.encode(new Uint8Array(32).fill(seed))
}
