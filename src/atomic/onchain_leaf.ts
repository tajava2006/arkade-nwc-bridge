import { Script, TaprootControlBlock } from '@scure/btc-signer'
import { Transaction, scriptFromTapLeafScript, type Identity, type TapLeafScript } from '@arkade-os/sdk'

// Spending an unrolled swap output on chain through one of its leaves: the
// VHTLC's unilateralClaim (receiver + preimage, after d_c) or its
// unilateralRefundWithoutReceiver (sender, after d_s) — the paths F32 was about
// (F32_VHTLC_PLAN §7). The output is an ordinary taproot output by then; only
// the leaf's CSV (nSequence) and, for the claim, the preimage matter.
//
// scure's finalize can't place a condition witness, so a preimage leaf is laid
// out by hand: [sigs in reverse script order, preimage, script, control block]
// — the same layout the SDK's onchainSpend uses.

export interface LeafSpendArgs {
  txid: string
  vout: number
  value: number
  /** The unrolled output's scriptPubKey (the swap script's). */
  pkScript: Uint8Array
  leaf: TapLeafScript
  /** BIP-68 sequence for the leaf's CSV (timelockToSequence). */
  sequence: number
  /** The claim leaf's condition: the swap preimage. Absent for a plain CSV leaf. */
  preimage?: Uint8Array
  /** Where the value goes (a scriptPubKey). */
  destination: Uint8Array
  feeSats: number
}

function unsigned(a: LeafSpendArgs): Transaction {
  const out = a.value - a.feeSats
  if (out <= 330) throw new Error(`leaf spend of ${a.value} sats at a ${a.feeSats}-sat fee leaves ${out} — not worth a dust output`)
  const tx = new Transaction({ version: 2 })
  tx.addInput({
    txid: a.txid,
    index: a.vout,
    witnessUtxo: { amount: BigInt(a.value), script: a.pkScript },
    tapLeafScript: [a.leaf],
    sequence: a.sequence,
  })
  tx.addOutput({ script: a.destination, amount: BigInt(out) })
  return tx
}

/** Finalize input `index` of a signed tx spending a condition (preimage) leaf. */
export function finalizeConditionInput(tx: Transaction, index: number, preimage: Uint8Array): void {
  const input = tx.getInput(index)
  const leaf = input.tapLeafScript?.[0]
  if (!leaf) throw new Error('leaf spend has no tap leaf')
  const script = scriptFromTapLeafScript(leaf)
  const ops = Script.decode(script)
  const position = (pubKey: Uint8Array) =>
    ops.findIndex((op) => op instanceof Uint8Array && op.length === pubKey.length && op.every((b, i) => b === pubKey[i]))
  const sigs = (input.tapScriptSig ?? [])
    .map(([{ pubKey }, sig]) => ({ sig, pos: position(pubKey) }))
    .filter((s) => s.pos !== -1)
    .sort((x, y) => x.pos - y.pos)
    .map((s) => s.sig)
    .reverse()
  if (sigs.length === 0) throw new Error('leaf spend carries no signature for its leaf')
  tx.updateInput(index, { finalScriptWitness: [...sigs, preimage, script, TaprootControlBlock.encode(leaf[0])] })
}

/** Build, sign and finalize the spend; returns the raw tx. */
export async function signLeafSpend(a: LeafSpendArgs, identity: Identity): Promise<Transaction> {
  const tx = await identity.sign(unsigned(a))
  if (a.preimage) finalizeConditionInput(tx, 0, a.preimage)
  else tx.finalize()
  return tx
}

/**
 * The same spend at `feeRate` sat/vB: sign once at a nominal fee to learn the
 * vsize (the witness is fixed-size), then rebuild at the exact fee.
 */
export async function signLeafSpendAtRate(
  a: Omit<LeafSpendArgs, 'feeSats'>,
  feeRate: number,
  identity: Identity,
): Promise<Transaction> {
  const probe = await signLeafSpend({ ...a, feeSats: 1 }, identity)
  return signLeafSpend({ ...a, feeSats: Math.ceil(probe.vsize * feeRate) }, identity)
}
