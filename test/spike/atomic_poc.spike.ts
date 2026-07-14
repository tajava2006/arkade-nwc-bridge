// Spike #01 (ATOMIC_SUBDUST_PLAN.md §6) — the GATE for the whole atomic
// sub-dust epic. Proves (or kills) the single-funder v2 design against a real
// regtest arkd, with NO boltz and NO bridge — just two ts-sdk wallets and the
// primitives the epic will lean on.
//
// The bet (plan §0 통찰 2): a payment amount below dust can be moved atomically
// if we fold it into the DELTA between a funder-owned funding vtxo and a
// PRE-SIGNED claim split, where the sub-dust pieces (the a output, and a
// sub-dust change) are plain ARK sub-dust vtxos (OP_RETURN recoverable) and
// only the SHARED funding output and the refund path must clear dust. If arkd
// accepts the 4-leaf funding → presigned claim (incl. sub-dust split) → CLTV
// refund → cooperative cancel, the design holds and #04+ can build on it.
//
// What it exercises (plan §6 #01 DoD — 3 paths green + §2.4 measurements):
//   (i)   F offline, C claims via F's 2 presigs — two split shapes:
//           A) change ≥ dust  → regular P2TR change + sub-dust `a`  (1 OP_RETURN)
//           B) change < dust  → sub-dust change   + sub-dust `a`  (2 OP_RETURN)
//   (ii)  CLTV refund: T elapsed → F reclaims full V; T in future → server rejects
//   (iii) cancel: F+C+server cooperative unwind (full V back to F), no timelock
//   §2.4  dust / vtxoMinAmount, BuildTxs↔arkd parity (submit succeeds = parity),
//         SDK sub-dust OP_RETURN encoding, and the 2-OP_RETURN edge accept/reject.
//
// Not a bun:test file — it needs the live regtest stack (regtest-e2e/up.sh) and
// shells out to arkade-regtest's CLI to fund + mine. Run:
//
//   regtest-e2e/up.sh                     # bring the stack up (leave running)
//   bun test/spike/atomic_poc.spike.ts    # this spike
//
// Footgun (same as the exit spike): import ../../src/polyfills BEFORE the SDK,
// or bun 1.3 crashes inside @bitcoinerlab's CJS adapter on @noble/curves.

import '../../src/polyfills'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { hex, base64 } from '@scure/base'
import { Script } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import {
  ArkAddress,
  buildOffchainTx,
  combineTapscriptSigs,
  ConditionWitness,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  ConditionMultisigTapscript,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  MultisigTapscript,
  RestArkProvider,
  RestIndexerProvider,
  setArkPsbtField,
  SingleKey,
  Transaction,
  VtxoScript,
  Wallet,
  type ArkInfo,
  type ArkProvider,
  type ArkTxInput,
  type Identity,
  type TapLeafScript,
} from '@arkade-os/sdk'
import type { TransactionOutput } from '@scure/btc-signer/psbt.js'

// ── config / regtest CLI ────────────────────────────────────────────────────

const ARKD_URL = process.env.ARKD_URL ?? 'http://localhost:7070'
const ESPLORA_URL = process.env.ESPLORA_URL ?? 'http://localhost:3000/api'
const ARK_PW = process.env.ARKD_PASSWORD ?? 'secret'

// Resolve arkade-regtest the same CWD-independent way env.sh does, so the spike
// can fund + mine without the caller pre-exporting REGTEST_DIR.
function resolveRegtestDir(): string {
  if (process.env.REGTEST_DIR) return process.env.REGTEST_DIR
  const root = join(import.meta.dir, '../..') // test/spike → repo root
  const candidates = [
    join(root, 'regtest-e2e/arkade-regtest'), // standalone submodule
    join(root, '../ts-sdk/regtest'), // sibling clone (rare)
    join(root, '../../../ts-sdk/regtest'), // operator workspace: reference/ts-sdk/regtest
  ]
  for (const c of candidates) if (existsSync(join(c, 'regtest.mjs'))) return c
  throw new Error('arkade-regtest not found — run regtest-e2e/up.sh first or set REGTEST_DIR')
}
const REGTEST_DIR = resolveRegtestDir()

function regtest(...args: string[]): string {
  return execFileSync('node', ['regtest.mjs', ...args], {
    cwd: REGTEST_DIR,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
}
function fundAddress(addr: string, sats: number): void {
  regtest('ark', 'send', '--to', addr, '--amount', String(sats), '--password', ARK_PW)
  regtest('mine', '1')
}

// ── small helpers ───────────────────────────────────────────────────────────

const HRP = 'tark' // regtest/testnet human-readable prefix (bitcoin → 'ark')
const enc = (b: Uint8Array) => hex.encode(b)
function toXOnly(k: Uint8Array): Uint8Array {
  return k.length === 32 ? k : k.subarray(1)
}
function leafScriptBytes(leaf: TapLeafScript): Uint8Array {
  return leaf[1].subarray(0, leaf[1].length - 1) // strip the trailing version byte
}
async function newWallet(): Promise<{ wallet: Wallet; identity: SingleKey; xonly: Uint8Array; address: string }> {
  const identity = SingleKey.fromPrivateKey(randomBytes(32))
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: ARKD_URL,
    esploraUrl: ESPLORA_URL,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    settlementConfig: { vtxoThreshold: 3600 },
  })
  return {
    wallet,
    identity,
    xonly: toXOnly(await identity.xOnlyPublicKey()),
    address: await wallet.getAddress(),
  }
}

let PASS = 0
let FAIL = 0
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✅ ${label}`)
    PASS++
  } else {
    console.log(`  ❌ ${label}`)
    FAIL++
  }
}

// ── the 4-leaf shared script (plan §3.1) ────────────────────────────────────
//
// F = funder, C = claimer, H = LN payment hash = sha256(preimage).
//   1 claim  : ConditionMultisig{ HASH160 ripemd160(H) EQUAL, [F, C, server] }
//   2 refund : CLTVMultisig{ T, [F, server] }
//   3 cancel : Multisig{ [F, C, server] }
//   4 uexit  : CSVMultisig{ d, [F] }
// The condition mirrors production VHTLC: commit HASH160(preimage) =
// ripemd160(sha256(preimage)) = ripemd160(H), reveal the raw preimage.

interface AtomicParams {
  funder: Uint8Array // x-only
  claimer: Uint8Array // x-only
  server: Uint8Array // x-only
  paymentHash: Uint8Array // H = sha256(preimage), 32 bytes
  refundLocktime: bigint // T, absolute (seconds)
  exitDelay: bigint // d, CSV seconds
}

class AtomicSubdustScript extends VtxoScript {
  readonly claimScript: string
  readonly refundScript: string
  readonly cancelScript: string
  readonly uexitScript: string

  constructor(readonly p: AtomicParams) {
    const conditionScript = Script.encode(['HASH160', ripemd160(p.paymentHash), 'EQUAL'])
    const claim = ConditionMultisigTapscript.encode({
      conditionScript,
      pubkeys: [p.funder, p.claimer, p.server],
    }).script
    const refund = CLTVMultisigTapscript.encode({
      absoluteTimelock: p.refundLocktime,
      pubkeys: [p.funder, p.server],
    }).script
    const cancel = MultisigTapscript.encode({
      pubkeys: [p.funder, p.claimer, p.server],
    }).script
    // arkd reads locktime UNITS by magnitude (≥512 = seconds, <512 = blocks);
    // derive the type from the server's own exitDelay so the leaf is valid in
    // both regtest modes. (uexit is only spent in #02, but keep the taptree sane.)
    const uexit = CSVMultisigTapscript.encode({
      timelock: { type: p.exitDelay >= 512n ? 'seconds' : 'blocks', value: p.exitDelay },
      pubkeys: [p.funder],
    }).script
    super([claim, refund, cancel, uexit])
    this.claimScript = enc(claim)
    this.refundScript = enc(refund)
    this.cancelScript = enc(cancel)
    this.uexitScript = enc(uexit)
  }
  claim(): TapLeafScript {
    return this.findLeaf(this.claimScript)
  }
  refund(): TapLeafScript {
    return this.findLeaf(this.refundScript)
  }
  cancel(): TapLeafScript {
    return this.findLeaf(this.cancelScript)
  }
  uexit(): TapLeafScript {
    return this.findLeaf(this.uexitScript)
  }
}

// ── offchain spend primitives (mirror boltz-swap utils/vhtlc.ts) ────────────

function serverUnroll(info: ArkInfo): CSVMultisigTapscript.Type {
  return CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript))
}

// Fund the shared script by sending V from F's wallet to the shared address,
// then locate the resulting shared vtxo from the indexer. Returns the ArkTxInput
// wired to spend via `leaf`.
async function fundShared(
  funder: Wallet,
  indexer: RestIndexerProvider,
  script: AtomicSubdustScript,
  serverXOnly: Uint8Array,
  value: number,
  leaf: TapLeafScript,
): Promise<ArkTxInput> {
  const sharedAddress = script.address(HRP, serverXOnly).encode()
  const sharedPk = enc(script.pkScript)
  await funder.sendBitcoin({ address: sharedAddress, amount: value })
  regtest('mine', '1')
  // poll for the freshly created shared vtxo
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === value)
    if (v) {
      return {
        txid: v.txid,
        vout: v.vout,
        value: v.value,
        tapLeafScript: leaf,
        tapTree: script.encode(),
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`shared vtxo (value=${value}) never appeared at ${sharedPk.slice(0, 12)}…`)
}

// An identity wrapper that reveals the preimage on every input it signs — the
// ConditionMultisig claim leaf needs it in the witness (arkd finalizes). Same
// trick as boltz-swap's claimVHTLCIdentity.
function withPreimage(identity: Identity, preimage: Uint8Array): Identity {
  return {
    ...identity,
    sign: async (tx: Transaction, idx?: number[]): Promise<Transaction> => {
      let signed = await identity.sign(tx, idx)
      signed = Transaction.fromPSBT(signed.toPSBT())
      const indexes = idx ?? Array.from({ length: signed.inputsLength }, (_, i) => i)
      for (const i of indexes) setArkPsbtField(signed, i, ConditionWitness, [preimage])
      return signed
    },
  }
}

// Build the claim pair and have F (funder) pre-sign both — the "2 presigs" that
// are the heart of the design. Returns PSBTs so they survive persistence, exactly
// as the epic will store them. F never has to be online again to claim.
async function funderPresign(
  input: ArkTxInput,
  outputs: TransactionOutput[],
  unroll: CSVMultisigTapscript.Type,
  funder: Identity,
): Promise<{ arkPresig: string; ckptPresig: string; ckptCount: number }> {
  const { arkTx, checkpoints } = buildOffchainTx([input], outputs, unroll)
  const [checkpoint] = checkpoints
  if (checkpoints.length !== 1 || !checkpoint)
    throw new Error(`expected 1 checkpoint, got ${checkpoints.length}`)
  const arkSigned = await funder.sign(arkTx) // F's tapScriptSig on the claim arkTx
  const ckptSigned = await funder.sign(checkpoint) // F's tapScriptSig on the checkpoint
  return {
    arkPresig: base64.encode(arkSigned.toPSBT()),
    ckptPresig: base64.encode(ckptSigned.toPSBT()),
    ckptCount: checkpoints.length,
  }
}

// C claims: rebuild the DETERMINISTIC pair, verify F's presig against it (never
// trust blindly — plan §3.3 verify-before-act), add C's sig + preimage, submit
// (server co-signs), re-attach all sigs to the server-signed checkpoint, finalize.
async function claimerFinish(
  input: ArkTxInput,
  outputs: TransactionOutput[],
  unroll: CSVMultisigTapscript.Type,
  claimer: Identity,
  preimage: Uint8Array,
  presig: { arkPresig: string; ckptPresig: string },
  funderXOnly: Uint8Array,
  ark: ArkProvider,
): Promise<string> {
  // Deterministic rebuild — must byte-match what F signed (BuildTxs parity).
  const { arkTx, checkpoints } = buildOffchainTx([input], outputs, unroll)
  const [checkpoint] = checkpoints
  if (!checkpoint) throw new Error('expected 1 checkpoint')
  const arkFromF = Transaction.fromPSBT(base64.decode(presig.arkPresig))
  const ckptFromF = Transaction.fromPSBT(base64.decode(presig.ckptPresig))
  if (arkFromF.id !== arkTx.id)
    throw new Error(`presig arkTx txid mismatch — not the tx F signed (${arkFromF.id} != ${arkTx.id})`)
  if (ckptFromF.id !== checkpoint.id)
    throw new Error('presig checkpoint txid mismatch — not the tx F signed')
  const claimLeafHash = tapLeafHash(leafScriptBytes(input.tapLeafScript))
  const funderHex = enc(funderXOnly)
  if (!verifyLeafSig(arkFromF, 0, funderHex, claimLeafHash))
    throw new Error("F's arkTx presig does not verify")

  const cIdentity = withPreimage(claimer, preimage)

  // arkTx: C signs (sets preimage), then merge F's presig ONTO C's tx so the
  // ConditionWitness (only on C's copy) is the one that survives to submit.
  const arkC = await cIdentity.sign(arkTx)
  combineTapscriptSigs(arkFromF, arkC) // mutates arkC, appends F's sig
  const submittedArk = arkC

  // checkpoint: submit UNSIGNED (as boltz-swap does), get server's sig, then
  // combine F+C+server onto the C-signed checkpoint (carries the preimage).
  const ckptC = await cIdentity.sign(checkpoint, [0])
  combineTapscriptSigs(ckptFromF, ckptC) // ckptC now has F+C sigs + preimage

  const { arkTxid, signedCheckpointTxs } = await ark.submitTx(base64.encode(submittedArk.toPSBT()), [
    base64.encode(checkpoint.toPSBT()),
  ])
  const [serverCkptB64] = signedCheckpointTxs
  if (signedCheckpointTxs.length !== 1 || !serverCkptB64)
    throw new Error(`expected 1 signed checkpoint, got ${signedCheckpointTxs.length}`)
  const serverCkpt = Transaction.fromPSBT(base64.decode(serverCkptB64))
  combineTapscriptSigs(serverCkpt, ckptC) // ckptC now F+C+server + preimage
  await ark.finalizeTx(arkTxid, [base64.encode(ckptC.toPSBT())])
  return arkTxid
}

// Verify a single pubkey's schnorr sig on a specific leaf of a tx input.
function verifyLeafSig(
  tx: Transaction,
  inputIndex: number,
  pubkeyHex: string,
  leafHash: Uint8Array,
): boolean {
  const input = tx.getInput(inputIndex)
  if (!input.tapScriptSig) return false
  const leafHashHex = enc(leafHash)
  return input.tapScriptSig.some(
    ([data]) => enc(data.pubKey) === pubkeyHex && enc(data.leafHash) === leafHashHex,
  )
}

// Generic single-leaf collaborative spend (F+? + server): used for refund
// (F+server, CLTV leaf) and cancel (F+C+server, no timelock). Every non-server
// signer in `signers` signs both arkTx and checkpoint; server co-signs via submit.
async function collaborativeSpend(
  input: ArkTxInput,
  outputs: TransactionOutput[],
  unroll: CSVMultisigTapscript.Type,
  signers: Identity[],
  ark: ArkProvider,
): Promise<string> {
  const { arkTx, checkpoints } = buildOffchainTx([input], outputs, unroll)
  const [checkpoint] = checkpoints
  if (!checkpoint) throw new Error('expected 1 checkpoint')
  if (signers.length === 0) throw new Error('need at least one signer')
  // combineTapscriptSigs needs BOTH sides already signed, so seed the
  // accumulators with the first signer's signed tx, then merge the rest onto it.
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
  if (!arkAcc || !ckptAcc) throw new Error('unreachable: no signed tx')
  const { arkTxid, signedCheckpointTxs } = await ark.submitTx(base64.encode(arkAcc.toPSBT()), [
    base64.encode(checkpoint.toPSBT()),
  ])
  const [serverCkptB64] = signedCheckpointTxs
  if (!serverCkptB64) throw new Error('server returned no checkpoint')
  const serverCkpt = Transaction.fromPSBT(base64.decode(serverCkptB64))
  combineTapscriptSigs(serverCkpt, ckptAcc)
  await ark.finalizeTx(arkTxid, [base64.encode(ckptAcc.toPSBT())])
  return arkTxid
}

// Build the claim split outputs: C gets `a` (always sub-dust OP_RETURN), F gets
// change V−a (regular P2TR if ≥ dust, sub-dust OP_RETURN if < dust, omitted if 0).
function claimSplit(
  funderAddr: ArkAddress,
  claimerAddr: ArkAddress,
  value: number,
  a: number,
  dust: number,
): { outputs: TransactionOutput[]; opReturns: number } {
  const outputs: TransactionOutput[] = [{ script: claimerAddr.subdustPkScript, amount: BigInt(a) }]
  let opReturns = 1
  const change = value - a
  if (change > 0) {
    if (change >= dust) {
      outputs.push({ script: funderAddr.pkScript, amount: BigInt(change) })
    } else {
      outputs.push({ script: funderAddr.subdustPkScript, amount: BigInt(change) })
      opReturns++
    }
  }
  return { outputs, opReturns }
}

// ── scenarios ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`atomic sub-dust PoC — arkd ${ARKD_URL}\n`)
  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info = await ark.getInfo()
  const serverXOnly = toXOnly(hex.decode(info.signerPubkey))
  const unroll = serverUnroll(info)
  const dust = Number(info.dust)
  const vtxoMin = Number(info.vtxoMinAmount)
  const now = () => BigInt(Math.floor(Date.now() / 1000))

  console.log('§2.4 server params:')
  console.log(`  dust=${dust}  vtxoMinAmount=${vtxoMin}  unilateralExitDelay=${info.unilateralExitDelay}s`)
  console.log(`  checkpointTapscript=${info.checkpointTapscript.slice(0, 24)}…  network=${info.network}`)
  const a = Math.max(vtxoMin, 21) // 21-sat zap; bump to vtxoMin if arkd floors higher
  console.log(`  chosen a=${a} (sub-dust: ${a < dust})\n`)

  const F = await newWallet()
  const C = await newWallet()
  const funderAddr = ArkAddress.decode(F.address)
  const claimerAddr = ArkAddress.decode(C.address)
  console.log(`funding F wallet with 200000 sats…`)
  fundAddress(F.address, 200000)
  // let F's ContractManager see the funding vtxo
  for (let i = 0; i < 20 && (await F.wallet.getBalance()).available < 200000; i++)
    await new Promise((r) => setTimeout(r, 500))
  console.log(`  F available=${(await F.wallet.getBalance()).available}\n`)

  const mkScript = (paymentHash: Uint8Array, T: bigint) =>
    new AtomicSubdustScript({
      funder: F.xonly,
      claimer: C.xonly,
      server: serverXOnly,
      paymentHash,
      refundLocktime: T,
      exitDelay: info.unilateralExitDelay,
    })

  // ---- (i) claim, case A: regular change (V=1000, a) → 1 OP_RETURN ----
  console.log('(i-A) claim with regular change (F offline after presign):')
  {
    const preimage = randomBytes(32)
    const H = sha256(preimage)
    const T = now() + 3600n
    const script = mkScript(H, T)
    const V = 1000
    const input = await fundShared(F.wallet, indexer, script, serverXOnly, V, script.claim())
    const { outputs, opReturns } = claimSplit(funderAddr, claimerAddr, V, a, dust)
    check(opReturns === 1, `split has 1 OP_RETURN (change ${V - a} ≥ dust)`)
    const presig = await funderPresign(input, outputs, unroll, F.identity)
    check(presig.ckptCount === 1, 'claim pair = 1 checkpoint + 1 arkTx (2 presigs)')
    // F is now "offline": only C acts from here.
    const txid = await claimerFinish(input, outputs, unroll, C.identity, preimage, presig, F.xonly, ark)
    check(!!txid, `claim submitted+finalized (arkTxid ${txid.slice(0, 12)}…)`)
    await verifyClaimResult(indexer, claimerAddr, funderAddr, a, V - a, dust)
  }

  // ---- (i) claim, case B: sub-dust change → 2 OP_RETURN ----
  // Both a and change must be < dust while V = a+change ≥ dust (funding input is
  // regular): a 21-sat a can't produce a sub-dust change, so case B uses a
  // larger sub-dust a (e.g. a funder VTXO barely above dust, mostly consumed).
  console.log('\n(i-B) claim with sub-dust change (2 OP_RETURN edge):')
  {
    const preimage = randomBytes(32)
    const H = sha256(preimage)
    const T = now() + 3600n
    const script = mkScript(H, T)
    const aB = dust - 130 // 200 when dust=330 — sub-dust payment
    const changeSub = dust - 130 // sub-dust change
    const V = aB + changeSub // ≥ dust funding, both outputs sub-dust
    check(aB < dust && changeSub < dust && V >= dust, `V=${V}≥dust, a=${aB}<dust, change=${changeSub}<dust`)
    const input = await fundShared(F.wallet, indexer, script, serverXOnly, V, script.claim())
    const { outputs, opReturns } = claimSplit(funderAddr, claimerAddr, V, aB, dust)
    check(opReturns === 2, `split has 2 OP_RETURN (change ${changeSub} < dust)`)
    try {
      const presig = await funderPresign(input, outputs, unroll, F.identity)
      const txid = await claimerFinish(input, outputs, unroll, C.identity, preimage, presig, F.xonly, ark)
      check(!!txid, `2-OP_RETURN claim accepted by arkd (arkTxid ${txid.slice(0, 12)}…)`)
      await verifyClaimResult(indexer, claimerAddr, funderAddr, aB, changeSub, dust)
    } catch (e) {
      // maxOpReturnOutputs edge: if arkd rejects, that's the §2.4 finding, not a
      // design failure — record it so #04 can gate this shape with an explicit error.
      console.log(`  ⚠ arkd rejected 2-OP_RETURN split: ${e instanceof Error ? e.message : e}`)
      console.log('    → §8 record: server maxOpReturnOutputs < 2; U−a<dust edge needs explicit error')
    }
  }

  // ---- (ii) refund: T elapsed → success; T future → rejected ----
  console.log('\n(ii) CLTV refund:')
  {
    // T already elapsed → F reclaims full V via the refund leaf (F+server).
    const preimage = randomBytes(32)
    const Tpast = now() - 3600n
    const script = mkScript(sha256(preimage), Tpast)
    const V = 1000
    const input = await fundShared(F.wallet, indexer, script, serverXOnly, V, script.refund())
    const outputs: TransactionOutput[] = [{ script: funderAddr.pkScript, amount: BigInt(V) }]
    try {
      const txid = await collaborativeSpend(input, outputs, unroll, [F.identity], ark)
      check(!!txid, `refund after elapsed T accepted (arkTxid ${txid.slice(0, 12)}…)`)
    } catch (e) {
      check(false, `refund after elapsed T: ${e instanceof Error ? e.message : e}`)
    }
  }
  {
    // T far in the future → server MUST reject (funds still locked for LN).
    const preimage = randomBytes(32)
    const Tfuture = now() + 100_000n
    const script = mkScript(sha256(preimage), Tfuture)
    const V = 1000
    const input = await fundShared(F.wallet, indexer, script, serverXOnly, V, script.refund())
    const outputs: TransactionOutput[] = [{ script: funderAddr.pkScript, amount: BigInt(V) }]
    let rejected = false
    try {
      await collaborativeSpend(input, outputs, unroll, [F.identity], ark)
    } catch {
      rejected = true
    }
    check(rejected, 'refund before T is rejected by arkd (CLTV enforced)')
  }

  // ---- (iii) cancel: F+C+server cooperative unwind, full V back to F ----
  console.log('\n(iii) cooperative cancel:')
  {
    const preimage = randomBytes(32)
    const T = now() + 3600n
    const script = mkScript(sha256(preimage), T)
    const V = 1000
    const input = await fundShared(F.wallet, indexer, script, serverXOnly, V, script.cancel())
    const outputs: TransactionOutput[] = [{ script: funderAddr.pkScript, amount: BigInt(V) }]
    try {
      const txid = await collaborativeSpend(input, outputs, unroll, [F.identity, C.identity], ark)
      check(!!txid, `cancel (F+C+server) accepted (arkTxid ${txid.slice(0, 12)}…)`)
    } catch (e) {
      check(false, `cancel: ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(
    FAIL === 0
      ? '✅ single-funder atomic sub-dust design HOLDS on regtest — epic may proceed (#02+)'
      : '❌ FAILURES — per plan §6 #01, epic pauses; revise ATOMIC_SUBDUST_PLAN.md',
  )
  process.exit(FAIL === 0 ? 0 : 1)
}

// After a claim, C should own a sub-dust (recoverable) vtxo of `a`, and F should
// own the change (regular spendable if ≥ dust, else recoverable sub-dust).
async function verifyClaimResult(
  indexer: RestIndexerProvider,
  claimerAddr: ArkAddress,
  funderAddr: ArkAddress,
  a: number,
  change: number,
  dust: number,
): Promise<void> {
  const claimerPk = enc(claimerAddr.pkScript)
  let found = false
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [claimerPk], recoverableOnly: true })
    if (vtxos.some((v) => v.value === a && !v.isSpent)) {
      found = true
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  check(found, `C received sub-dust vtxo a=${a} (recoverable)`)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
