import { createHash } from 'node:crypto'
import { base64, hex } from '@scure/base'
import { ConditionWitness, Transaction, getArkPsbtFields } from '@arkade-os/sdk'

// Pure preimage harvesting for atomic sub-dust RECEIVE settlement (F1,
// SUBDUST_ATOMIC_SECURITY_REVIEW.md). Kept in its own dependency-light module
// (only @arkade-os/sdk + @scure/base + node:crypto) so it is unit-testable in
// isolation, without dragging in the service's LND/store imports.

const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest()

/**
 * Harvest the LN preimage from the receiver's on-chain claim of the shared vtxo.
 * The claim spends the shared outpoint via the hashlock claim leaf, so the
 * 32-byte preimage is revealed either in the ConditionWitness ark field
 * (accepted form) or in the finalized witness stack (finalized form) of the
 * input that consumes `shared`. A candidate is accepted only when
 * sha256(candidate) == paymentHash — verified by hash, never trusted from a
 * field label or from the counterparty — so the receiver cannot make us
 * settle without having actually revealed the real preimage.
 *
 * `servedTxs` is arkd's getVirtualTxs response for `spentByTxid`; entries are
 * keyed by their decoded txid, never by response order.
 */
export function extractPreimageFromClaim(
  servedTxs: string[],
  spentByTxid: string,
  shared: { txid: string; vout: number },
  paymentHash: Buffer,
): Buffer | undefined {
  for (const psbtB64 of servedTxs) {
    let tx: Transaction
    try {
      tx = Transaction.fromPSBT(base64.decode(psbtB64))
    } catch {
      continue
    }
    if (tx.id !== spentByTxid) {
      continue
    }
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i)
      if (!inp.txid || hex.encode(inp.txid) !== shared.txid || inp.index !== shared.vout) {
        continue
      }
      const candidates: Uint8Array[] = []
      try {
        for (const wit of getArkPsbtFields(tx, i, ConditionWitness)) {
          candidates.push(...wit)
        }
      } catch {
        // ConditionWitness field absent on this input — fall through to the stack
      }
      if (inp.finalScriptWitness) {
        candidates.push(...inp.finalScriptWitness)
      }
      for (const c of candidates) {
        if (c.length === 32 && sha256(Buffer.from(c)).equals(paymentHash)) {
          return Buffer.from(c)
        }
      }
    }
  }
  return undefined
}
