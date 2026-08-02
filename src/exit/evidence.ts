import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { Transaction, type Outpoint, type VirtualCoin } from '@arkade-os/sdk'
import type { VaultVtxo } from './vault'

// Evidence for GC (SPEND_EVIDENCE spike, test/spike/spend_evidence.spike.ts):
// a vault vtxo that vanished from the live set may only be deleted when its
// disappearance is provable WITHOUT trusting the server's word —
//
//   spent-verified  the indexer names a spending tx (spentBy — set for both
//                   offchain sends and settlement forfeits, spike-confirmed)
//                   AND that tx carries a signature by OUR OWN key over the
//                   input that consumes this outpoint. Any wallet holding
//                   the nsec produces exactly this artifact, so a spend made
//                   from another client with the same key verifies the same
//                   way — no local spend journal, no false alarms.
//   expired         batch expiry passed by the LOCAL clock against the
//                   locally stored expiresAt. The server sweeping after
//                   expiry is legitimate (and it needs no signature), so
//                   there is nothing left to prove — and nothing left to
//                   exit either. The caller flags it for review rather than
//                   deleting: the lapse is the user's fault, but funds must
//                   not vanish without an explanation.
//   unproven        everything else. The caller quarantines: row + proofs
//                   stay, the pre-signed chain remains exitable until
//                   expiry. Whether it's a server lie or an indexer bug,
//                   the money's escape hatch must not hinge on it.
//
// classifyDisappearance THROWS on network failure — that's indeterminate,
// not unproven: the caller keeps the row un-flagged and retries next pass
// (same per-vtxo isolation the rest of ProofSync uses).

// A fourth evidence class lives OUTSIDE classifyDisappearance because it is
// pass-level, not per-row: settlement absorption. Sub-dust/swept round inputs
// are absorbed WITHOUT a forfeit (arkd skips forfeits for recoverable-class
// inputs), so no tx signed by our key ever exists for them — the per-row
// machinery above can only land on 'unproven'/'expired', turning every
// refresh that folds sub-dust into a false alarm (observed mainnet
// 2026-07-27). See resolveAbsorbedByConservation.

export type Disappearance =
  | { kind: 'spent-verified'; spentBy: string }
  | { kind: 'expired' }
  | { kind: 'unproven'; reason: string }

/** The two indexer reads evidence needs — structural subset of IndexerProvider. */
export interface EvidenceIndexer {
  getVtxos(opts: { outpoints: Outpoint[] }): Promise<{ vtxos: VirtualCoin[] }>
  getVirtualTxs(
    txids: string[],
    opts?: { pageIndex?: number; pageSize?: number },
  ): Promise<{ txs: string[] }>
}

/**
 * Does this PSBT contain OUR schnorr signature over the input that spends
 * `outpoint`? Pure — everything (prevouts included) must come from the PSBT
 * itself; a tx that omits witnessUtxo data can't be verified and is treated
 * as no evidence. Tries the pubkey-labelled PSBT fields first (what arkd
 * serves today, spike-confirmed), then falls back to a finalized witness
 * stack in case a future indexer serves finalized txs.
 */
export function verifyOurSpend(
  psbtB64: string,
  outpoint: { txid: string; vout: number },
  ourXOnlyPubkey: Uint8Array,
): boolean {
  let tx: Transaction
  try {
    tx = Transaction.fromPSBT(base64.decode(psbtB64))
  } catch {
    return false
  }

  let inputIdx = -1
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i)
    if (inp.txid && hex.encode(inp.txid) === outpoint.txid && inp.index === outpoint.vout) {
      inputIdx = i
    }
  }
  if (inputIdx < 0) return false

  // BIP341 sighash commits to every input's prevout — all must be embedded.
  const prevScripts: Uint8Array[] = []
  const prevAmounts: bigint[] = []
  for (let i = 0; i < tx.inputsLength; i++) {
    const wu = tx.getInput(i).witnessUtxo
    if (!wu) return false
    prevScripts.push(wu.script)
    prevAmounts.push(BigInt(wu.amount))
  }

  const inp = tx.getInput(inputIdx)
  const ourHex = hex.encode(ourXOnlyPubkey)

  // Candidate (leafScript, leafVer, sig) triples to verify.
  const candidates: { script: Uint8Array; ver: number; sig: Uint8Array }[] = []

  // 1) labelled PSBT fields: tapScriptSig entries carry (pubkey, leafHash);
  //    match ours to the tapLeafScript whose hash agrees — never trust entry
  //    order to pair them.
  for (const [pub, sig] of inp.tapScriptSig ?? []) {
    if (hex.encode(pub.pubKey) !== ourHex) continue
    for (const [, ls] of inp.tapLeafScript ?? []) {
      // tapLeafScript value = script || leafVer (1 trailing byte), same
      // split btc-signer's own signIdx does
      const script = ls.subarray(0, ls.length - 1)
      const ver = ls[ls.length - 1]!
      if (hex.encode(tapLeafHash(script, ver)) === hex.encode(pub.leafHash)) {
        candidates.push({ script, ver, sig })
      }
    }
  }

  // 2) finalized witness stack: [..sigs.., script, controlBlock] — sigs are
  //    unlabelled, so try every sig-shaped item. (No annex handling: arkd
  //    doesn't emit one; an annexed tx just fails verification → quarantine,
  //    which is the visible-not-silent failure mode we want.)
  if (candidates.length === 0 && inp.finalScriptWitness && inp.finalScriptWitness.length >= 2) {
    const stack = inp.finalScriptWitness
    const script = stack[stack.length - 2]!
    const ver = stack[stack.length - 1]![0]! & 0xfe
    for (const item of stack.slice(0, -2)) {
      if (item.length === 64 || item.length === 65) candidates.push({ script, ver, sig: item })
    }
  }

  for (const c of candidates) {
    const hashType = c.sig.length === 65 ? c.sig[64]! : 0x00
    try {
      const preimage = tx.preimageWitnessV1(
        inputIdx,
        prevScripts,
        hashType,
        prevAmounts,
        undefined,
        c.script,
        c.ver,
      )
      if (schnorr.verify(c.sig.subarray(0, 64), preimage, ourXOnlyPubkey)) return true
    } catch {
      // malformed candidate (e.g. random 64B witness item) — try the next
    }
  }
  return false
}

/** One vault row missing from the live set, prepared for the conservation check. */
export interface AbsorptionCandidate {
  /** `txid:vout`, the key ProofSync reports in results */
  outpoint: string
  /** amount from OUR vault row — never the server's word */
  valueSat: number
  /** the indexer's `settledBy` for this outpoint — a grouping HINT, not evidence */
  settledBy: string | undefined
}

/**
 * Value-conservation evidence for settlement absorption: vault rows the
 * server claims were consumed by commitment C are proven legitimately
 * absorbed when the sats C took from us exactly equal the sats C created
 * for us. The invariant holds for ANY initiator — this bridge's
 * consolidate-all loop, the SDK's backstop renew, a manual refresh, even
 * another wallet holding the same nsec — because the round's outputs land
 * in our live set either way. Amounts on the left come from our own vault;
 * the right side uses the same settledBy↔commitmentTxIds correlation the
 * SDK's history builder uses, and `settledBy` only GROUPS: a lie shifts
 * rows between groups and breaks the equality, so the failure mode is
 * always "stay quarantined", never "wrongly delete".
 *
 * Deliberately exact-match and single-pass-scoped. Known corners that fail
 * conservative (row stays flagged for a manual Forget): a boarding UTXO
 * riding the same round (its sats inflate the output), an offboard round
 * (output went onchain, not into the live set), the lump being spent before
 * this pass ran, or a crash that already deleted some forfeited siblings.
 */
export function resolveAbsorbedByConservation(
  disappeared: readonly AbsorptionCandidate[],
  liveVtxos: readonly Pick<VirtualCoin, 'value' | 'virtualStatus'>[],
): Set<string> {
  const groups = new Map<string, AbsorptionCandidate[]>()
  for (const c of disappeared) {
    if (!c.settledBy) continue
    const g = groups.get(c.settledBy)
    if (g) g.push(c)
    else groups.set(c.settledBy, [c])
  }
  const absorbed = new Set<string>()
  for (const [commitment, rows] of groups) {
    const consumedSat = rows.reduce((s, r) => s + r.valueSat, 0)
    // A round's outputs for us = live vtxos whose commitmentTxIds are exactly
    // this commitment (the SDK's own settlement correlation). Children spent
    // onward or received C-descendants carry different/multiple ids and drop
    // out, which can only break the equality — the safe direction.
    const createdSat = liveVtxos.reduce((s, v) => {
      const ids = v.virtualStatus?.commitmentTxIds
      const fromThisRound = !!ids && ids.length > 0 && ids.every((id) => id === commitment)
      return s + (fromThisRound ? v.value : 0)
    }, 0)
    if (consumedSat > 0 && consumedSat === createdSat) {
      for (const r of rows) absorbed.add(r.outpoint)
    }
  }
  return absorbed
}

/**
 * Classify why a vault vtxo is missing from the live set. Network errors
 * propagate (indeterminate — retry next pass); a server that RESPONDS but
 * can't produce verifiable evidence yields 'unproven'.
 */
export async function classifyDisappearance(
  indexer: EvidenceIndexer,
  vtxo: Pick<VaultVtxo, 'txid' | 'vout' | 'expiresAt'>,
  ourXOnlyPubkey: Uint8Array,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<Disappearance> {
  // Expiry first: past expiry the server may sweep without our signature, so
  // "disappeared" needs no further explanation — and the pre-signed chain is
  // no longer broadcastable anyway, so keeping it protects nothing.
  if (vtxo.expiresAt !== null && nowSec > vtxo.expiresAt) {
    return { kind: 'expired' }
  }

  const res = await indexer.getVtxos({ outpoints: [{ txid: vtxo.txid, vout: vtxo.vout }] })
  const row = res.vtxos.find((v) => v.txid === vtxo.txid && v.vout === vtxo.vout)
  if (!row) {
    return { kind: 'unproven', reason: 'indexer no longer acknowledges the outpoint' }
  }
  if (!row.spentBy) {
    // Unrolled-but-unspent: the pre-signed chain hit the chain, but no exit op
    // here explains it (ops are honored before evidence is asked) — another
    // device holding the nsec, or a local op that failed mid-broadcast. The
    // funds sit onchain at our own key with the CSV clock running, so the ask
    // is "go sweep it", not "the server is lying" — but quarantine (row +
    // proofs kept, loud after grace) is still the right mechanics: it must
    // not be deletable on the server's word, and it must not stay silent.
    if (row.isUnrolled) {
      return {
        kind: 'unproven',
        reason:
          'broadcast onchain via unilateral exit, but no exit op on this bridge — unrolled from another device or a failed local op; the CSV clock is running, sweep it from /exit',
      }
    }
    return {
      kind: 'unproven',
      reason: `outpoint still ${row.virtualStatus?.state ?? 'unspent'} per the indexer, yet dropped from the live set`,
    }
  }

  const served = await indexer.getVirtualTxs([row.spentBy], { pageIndex: 0, pageSize: 100 })
  // key by decoded txid, not response order — a proof filed under the wrong
  // label must not pass as evidence
  let spendPsbt: string | undefined
  for (const psbtB64 of served.txs) {
    try {
      if (Transaction.fromPSBT(base64.decode(psbtB64)).id === row.spentBy) {
        spendPsbt = psbtB64
      }
    } catch {
      // unparseable entry — skip
    }
  }
  if (!spendPsbt) {
    return { kind: 'unproven', reason: `indexer names spentBy ${row.spentBy} but does not serve it` }
  }

  if (!verifyOurSpend(spendPsbt, { txid: vtxo.txid, vout: vtxo.vout }, ourXOnlyPubkey)) {
    return {
      kind: 'unproven',
      reason: `spentBy ${row.spentBy} does not carry our signature over this outpoint`,
    }
  }
  return { kind: 'spent-verified', spentBy: row.spentBy }
}
