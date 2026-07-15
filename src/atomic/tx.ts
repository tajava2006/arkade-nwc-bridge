import { base64, hex } from '@scure/base'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import {
  ConditionWitness,
  CSVMultisigTapscript,
  Transaction,
  buildOffchainTx,
  combineTapscriptSigs,
  setArkPsbtField,
  type ArkProvider,
  type ArkTxInput,
  type Identity,
  type TapLeafScript,
} from '@arkade-os/sdk'
import type { AtomicVtxoScript } from './script'
import type { AtomicOutput } from './split'

// Deterministic tx builders + presign for the atomic sub-dust protocol
// (ATOMIC_SUBDUST_PLAN.md §3.2, §5). Formalizes the exact flow proven in spikes
// #01 (claim/refund/cancel) and #02 (uexit sweep). The wire format is PSBT
// base64 so the boltz vendored copy (§8 [#03]) uses these functions unchanged.

// ── wire format ────────────────────────────────────────────────────────────
export const encodePsbt = (tx: Transaction): string => base64.encode(tx.toPSBT())
export const decodePsbt = (b64: string): Transaction => Transaction.fromPSBT(base64.decode(b64))

/** Decode arkd's checkpointTapscript (from getInfo) into the server unroll script. */
export function serverUnrollScript(checkpointTapscript: string): CSVMultisigTapscript.Type {
  return CSVMultisigTapscript.decode(hex.decode(checkpointTapscript))
}

// ── shared-vtxo inputs ───────────────────────────────────────────────────────
/** A shared 4-leaf vtxo to be spent via one of its leaves. */
export interface SharedVtxo {
  txid: string
  vout: number
  value: number
  script: AtomicVtxoScript
}

function arkInput(shared: SharedVtxo, leaf: TapLeafScript): ArkTxInput {
  return {
    txid: shared.txid,
    vout: shared.vout,
    value: shared.value,
    tapLeafScript: leaf,
    tapTree: shared.script.encode(),
  }
}

function leafScriptBytes(leaf: TapLeafScript): Uint8Array {
  return leaf[1].subarray(0, leaf[1].length - 1) // strip the trailing leaf-version byte
}

/** Does `tx` input `i` carry a tapscript sig from `pubkey` on `leafHash`? */
function hasLeafSig(tx: Transaction, i: number, pubkey: Uint8Array, leafHash: Uint8Array): boolean {
  const input = tx.getInput(i)
  if (!input.tapScriptSig) return false
  const pk = hex.encode(pubkey)
  const lh = hex.encode(leafHash)
  return input.tapScriptSig.some(([d]) => hex.encode(d.pubKey) === pk && hex.encode(d.leafHash) === lh)
}

// ── the deterministic claim pair ─────────────────────────────────────────────
export interface ClaimPair {
  arkTx: Transaction
  checkpoint: Transaction
}

/**
 * Build the claim pair (checkpoint + arkTx) that spends the shared vtxo via its
 * claim leaf into the split outputs. Fully determined by (input, outputs,
 * serverUnrollScript), so both F (presigning) and C (claiming) rebuild the
 * byte-identical pair — that determinism is what makes the presig verifiable.
 */
export function buildClaimPair(shared: SharedVtxo, outputs: AtomicOutput[], unroll: CSVMultisigTapscript.Type): ClaimPair {
  const { arkTx, checkpoints } = buildOffchainTx([arkInput(shared, shared.script.claim())], outputs, unroll)
  const [checkpoint] = checkpoints
  if (checkpoints.length !== 1 || !checkpoint) {
    throw new Error(`atomic claim pair must have exactly 1 checkpoint, got ${checkpoints.length}`)
  }
  return { arkTx, checkpoint }
}

// ── presign (funder) ─────────────────────────────────────────────────────────
/** F's two partial signatures over the claim pair — the whole pre-commitment. */
export interface AtomicPresig {
  /** base64 PSBT of the claim arkTx carrying F's tapscript sig. */
  arkTx: string
  /** base64 PSBT of the checkpoint carrying F's tapscript sig. */
  checkpoint: string
}

/**
 * Funder pre-signs the claim pair (the "2 presigs"). After this F can go
 * offline: C completes the claim from the presig set alone.
 */
export async function presignClaim(
  shared: SharedVtxo,
  outputs: AtomicOutput[],
  unroll: CSVMultisigTapscript.Type,
  funder: Identity,
): Promise<AtomicPresig> {
  const { arkTx, checkpoint } = buildClaimPair(shared, outputs, unroll)
  return {
    arkTx: encodePsbt(await funder.sign(arkTx)),
    checkpoint: encodePsbt(await funder.sign(checkpoint)),
  }
}

// ── verify-before-act (claimer) ──────────────────────────────────────────────
export interface VerifiedPresig {
  arkTx: Transaction
  checkpoint: Transaction
  funderArkTx: Transaction
  funderCheckpoint: Transaction
}

/**
 * Verify F's presig against a deterministic local rebuild (plan §3.3
 * verify-before-act — the one remaining critical vector). Rejects if the
 * pre-signed txids don't match our rebuild (i.e. F signed a different split) or
 * if F's tapscript sig is absent/for the wrong key on the claim leaf.
 */
export function verifyPresig(
  shared: SharedVtxo,
  outputs: AtomicOutput[],
  unroll: CSVMultisigTapscript.Type,
  presig: AtomicPresig,
  funderXOnly: Uint8Array,
): VerifiedPresig {
  const { arkTx, checkpoint } = buildClaimPair(shared, outputs, unroll)
  const funderArkTx = decodePsbt(presig.arkTx)
  const funderCheckpoint = decodePsbt(presig.checkpoint)
  if (funderArkTx.id !== arkTx.id) {
    throw new Error(`presig arkTx txid mismatch — F signed a different tx (${funderArkTx.id} != ${arkTx.id})`)
  }
  if (funderCheckpoint.id !== checkpoint.id) {
    throw new Error('presig checkpoint txid mismatch — F signed a different tx')
  }
  // Both the checkpoint (spends shared via claim leaf) and the arkTx (spends the
  // checkpoint's inherited claim closure) commit the same claim-leaf script, so
  // one leaf hash verifies F's sig on both.
  const leafHash = tapLeafHash(leafScriptBytes(shared.script.claim()))
  if (!hasLeafSig(funderArkTx, 0, funderXOnly, leafHash)) throw new Error('F arkTx presig does not verify')
  if (!hasLeafSig(funderCheckpoint, 0, funderXOnly, leafHash)) throw new Error('F checkpoint presig does not verify')
  return { arkTx, checkpoint, funderArkTx, funderCheckpoint }
}

// ── claim finish (claimer) ───────────────────────────────────────────────────
/**
 * Wrap an identity so it reveals `preimage` on every input it signs — the claim
 * leaf's ConditionMultisig needs it in the witness (arkd assembles the final
 * witness). Same mechanism as boltz-swap's claimVHTLCIdentity.
 */
export function withPreimage(identity: Identity, preimage: Uint8Array): Identity {
  return {
    ...identity,
    sign: async (tx: Transaction, inputIndexes?: number[]): Promise<Transaction> => {
      let signed = await identity.sign(tx, inputIndexes)
      signed = Transaction.fromPSBT(signed.toPSBT())
      const indexes = inputIndexes ?? Array.from({ length: signed.inputsLength }, (_, i) => i)
      for (const i of indexes) setArkPsbtField(signed, i, ConditionWitness, [preimage])
      return signed
    },
  }
}

/**
 * Claimer completes the claim: verify F's presig, add C's sig + preimage,
 * combine F's presig, submit (server co-signs), re-attach all sigs to the
 * server-signed checkpoint, finalize. Returns the arkTxid.
 */
export async function finishClaim(
  shared: SharedVtxo,
  outputs: AtomicOutput[],
  unroll: CSVMultisigTapscript.Type,
  presig: AtomicPresig,
  claimer: Identity,
  preimage: Uint8Array,
  ark: ArkProvider,
): Promise<string> {
  const v = verifyPresig(shared, outputs, unroll, presig, shared.script.options.funder)
  const signer = withPreimage(claimer, preimage)

  // arkTx: C signs (sets preimage), then merge F's presig ONTO C's tx so the
  // ConditionWitness (only on C's copy) survives to submit.
  const arkC = await signer.sign(v.arkTx)
  combineTapscriptSigs(v.funderArkTx, arkC)

  // checkpoint: submit UNSIGNED, get the server sig, then combine F+C+server
  // onto the C-signed copy (which carries the preimage) for finalize.
  const ckptC = await signer.sign(v.checkpoint, [0])
  combineTapscriptSigs(v.funderCheckpoint, ckptC)

  const { arkTxid, signedCheckpointTxs } = await ark.submitTx(encodePsbt(arkC), [encodePsbt(v.checkpoint)])
  const [serverCkptB64] = signedCheckpointTxs
  if (signedCheckpointTxs.length !== 1 || !serverCkptB64) {
    throw new Error(`expected 1 server-signed checkpoint, got ${signedCheckpointTxs.length}`)
  }
  combineTapscriptSigs(decodePsbt(serverCkptB64), ckptC)
  await ark.finalizeTx(arkTxid, [encodePsbt(ckptC)])
  return arkTxid
}

// ── collaborative spend: refund (F+server) / cancel (F+C+server) ──────────────
/**
 * Single-leaf collaborative spend used for `refund` (F+server, after T) and
 * `cancel` (F+C+server, live). Every non-server signer signs both arkTx and
 * checkpoint; the server co-signs at submit. Returns the arkTxid.
 */
export async function collaborativeSpend(
  shared: SharedVtxo,
  leaf: TapLeafScript,
  outputs: AtomicOutput[],
  unroll: CSVMultisigTapscript.Type,
  signers: Identity[],
  ark: ArkProvider,
): Promise<string> {
  if (signers.length === 0) throw new Error('collaborativeSpend needs at least one signer')
  const { arkTx, checkpoints } = buildOffchainTx([arkInput(shared, leaf)], outputs, unroll)
  const [checkpoint] = checkpoints
  if (!checkpoint) throw new Error('expected 1 checkpoint')

  // combineTapscriptSigs needs both sides signed, so seed with the first
  // signer's signed tx, then merge the rest onto it.
  let arkAcc: Transaction | undefined
  let ckptAcc: Transaction | undefined
  for (const s of signers) {
    const a = await s.sign(arkTx)
    const c = await s.sign(checkpoint, [0])
    if (!arkAcc || !ckptAcc) {
      arkAcc = a
      ckptAcc = c
    } else {
      combineTapscriptSigs(a, arkAcc)
      combineTapscriptSigs(c, ckptAcc)
    }
  }
  if (!arkAcc || !ckptAcc) throw new Error('unreachable')

  const { arkTxid, signedCheckpointTxs } = await ark.submitTx(encodePsbt(arkAcc), [encodePsbt(checkpoint)])
  const [serverCkptB64] = signedCheckpointTxs
  if (!serverCkptB64) throw new Error('server returned no checkpoint')
  combineTapscriptSigs(decodePsbt(serverCkptB64), ckptAcc)
  await ark.finalizeTx(arkTxid, [encodePsbt(ckptAcc)])
  return arkTxid
}

/** Refund the full shared value to F after T (refund leaf, F+server). */
export function refundSpend(
  shared: SharedVtxo,
  outputs: AtomicOutput[],
  unroll: CSVMultisigTapscript.Type,
  funder: Identity,
  ark: ArkProvider,
): Promise<string> {
  return collaborativeSpend(shared, shared.script.refund(), outputs, unroll, [funder], ark)
}

/** Cooperatively unwind the shared vtxo to F (cancel leaf, F+C+server, live). */
export function cancelSpend(
  shared: SharedVtxo,
  outputs: AtomicOutput[],
  unroll: CSVMultisigTapscript.Type,
  funder: Identity,
  claimer: Identity,
  ark: ArkProvider,
): Promise<string> {
  return collaborativeSpend(shared, shared.script.cancel(), outputs, unroll, [funder, claimer], ark)
}

// ── uexit onchain sweep (after unroll, #02) ──────────────────────────────────
export interface UexitSweepArgs {
  txid: string
  vout: number
  value: number
  script: AtomicVtxoScript
  /** BIP68 sequence for the CSV exit delay (timelockToSequence of d). */
  sequence: number
  /** Destination onchain scriptPubKey (e.g. F's P2TR). */
  outputScript: Uint8Array
  /** Onchain fee in sats (output = value − fee). */
  feeSats: number
}

/**
 * Build the (unsigned) onchain tx that sweeps a fully-unrolled shared output via
 * the uexit leaf (CSV d, F only). Caller signs with F and finalizes. Version 2
 * for BIP68 relative-timelock enforcement.
 */
export function buildUexitSweep(args: UexitSweepArgs): Transaction {
  const out = args.value - args.feeSats
  if (out <= 0) throw new Error(`uexit sweep fee ${args.feeSats} ≥ value ${args.value}`)
  const tx = new Transaction({ version: 2 })
  tx.addInput({
    txid: args.txid,
    index: args.vout,
    witnessUtxo: { amount: BigInt(args.value), script: args.script.pkScript },
    tapLeafScript: [args.script.uexit()],
    sequence: args.sequence,
  })
  tx.addOutput({ script: args.outputScript, amount: BigInt(out) })
  return tx
}
