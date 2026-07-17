// Spike #03 (ATOMIC_SUBDUST_PLAN.md §6) — boltz-side ARK capability strategy.
//
// The v2 design needs boltz to do ARK KEY OPERATIONS itself (send direction:
// boltz = claimer C, key-only — sign the claim pair + submit/finalize; receive
// direction: boltz = funder F, needs a funded vtxo). fulmine can't do this
// (it's a custodial wallet node, not a signing SDK). Two options (plan §4):
//   α) embed @arkade-os/sdk INSIDE boltz-backend (its own key, RestArkProvider)
//   β) extend fulmine (Go) to expose the primitives.
// Plan says α first. This spike DECIDES α by proving it works in boltz's actual
// runtime and DoD "sign+submit once inside the boltz process".
//
// WHY THIS FILE IS .cjs RUN UNDER `node` (not the bun/TS spikes):
//   boltz-backend is CommonJS (tsconfig module Node20, no "type":"module"),
//   Node >=22.4, and has ZERO ark deps today. The real risk isn't the crypto
//   (proven in #01) — it's whether @arkade-os/sdk even LOADS and FUNCTIONS in
//   that runtime: the SDK pulls @noble/curves v2 (ESM-only), which classically
//   breaks CommonJS `require`. So this runs exactly as boltz would: a CJS
//   process, `require('@arkade-os/sdk')`, no Wallet (→ no missing-EventSource/
//   SSE dependency), just RestArkProvider + RestIndexerProvider + SingleKey.
//
// What it proves (boltz = C, the send-direction key-only claimer):
//   - require('@arkade-os/sdk') loads under Node CJS (the α gate)
//   - boltz gets arkd params (getInfo) and derives its receive address with no
//     Wallet (DefaultVtxo.Script)
//   - given a shared 4-leaf vtxo + F's 2 presigs, boltz signs (its own key +
//     preimage) + combines + submitTx + finalizeTx → receives the sub-dust a.
//     That's the exact boltz send-side op, executed in a boltz-shaped process.
//
// The funding is done by the regtest ark client (any party can pay the shared
// address); F here is only the presigner. Hashing uses Node's crypto so the
// spike itself needs no ESM-only dep — mirroring how a boltz patch would lean
// on Node builtins + the vendored protocol lib.
//
//   reference/ts-sdk/regtest → node regtest.mjs start --profile ark   (running)
//   node test/spike/atomic_boltz.spike.cjs

const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const crypto = require('node:crypto')
const sdk = require('@arkade-os/sdk')

const {
  ArkAddress,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  ConditionMultisigTapscript,
  ConditionWitness,
  DefaultVtxo,
  MultisigTapscript,
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Transaction,
  VtxoScript,
  buildOffchainTx,
  combineTapscriptSigs,
  setArkPsbtField,
} = sdk

const ARKD_URL = process.env.ARKD_URL || 'http://localhost:7070'
const ARK_PW = process.env.ARKD_PASSWORD || 'secret'
const HRP = 'tark'

// Buffer-based codecs + Node-crypto hashes — no ESM-only (@scure/@noble) imports
// in the spike's own code (the SDK bundles its own copy internally).
const toHex = (u8) => Buffer.from(u8).toString('hex')
const fromHex = (s) => Uint8Array.from(Buffer.from(s, 'hex'))
const toB64 = (u8) => Buffer.from(u8).toString('base64')
const fromB64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'))
const sha256 = (u8) => Uint8Array.from(crypto.createHash('sha256').update(u8).digest())
const ripemd160 = (u8) => Uint8Array.from(crypto.createHash('ripemd160').update(u8).digest())
const toXOnly = (k) => (k.length === 32 ? k : k.subarray(1))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function resolveRegtestDir() {
  if (process.env.REGTEST_DIR) return process.env.REGTEST_DIR
  const root = join(__dirname, '../..')
  for (const c of [
    join(root, 'regtest-e2e/arkade-regtest'),
    join(root, '../ts-sdk/regtest'),
    join(root, '../../../ts-sdk/regtest'),
  ])
    if (existsSync(join(c, 'regtest.mjs'))) return c
  throw new Error('arkade-regtest not found — set REGTEST_DIR')
}
const REGTEST_DIR = resolveRegtestDir()
const regtest = (...args) =>
  execFileSync('node', ['regtest.mjs', ...args], { cwd: REGTEST_DIR, encoding: 'utf8', maxBuffer: 1e7 })

let PASS = 0
let FAIL = 0
const check = (cond, label) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`)
  cond ? PASS++ : FAIL++
}

// OP_HASH160 <20-byte ripemd160(H)> OP_EQUAL — hand-encoded (matches
// @scure/btc-signer's Script.encode(['HASH160', h, 'EQUAL']); reveal = preimage).
function conditionScript(paymentHash) {
  return Uint8Array.from(Buffer.concat([Buffer.from([0xa9, 0x14]), ripemd160(paymentHash), Buffer.from([0x87])]))
}

// The same 4-leaf shared script as #01/#02 (claim/refund/cancel/uexit).
class AtomicSubdustScript extends VtxoScript {
  constructor(funder, claimer, server, paymentHash, refundLocktime, exitDelay) {
    const claim = ConditionMultisigTapscript.encode({
      conditionScript: conditionScript(paymentHash),
      pubkeys: [funder, claimer, server],
    }).script
    const refund = CLTVMultisigTapscript.encode({ absoluteTimelock: refundLocktime, pubkeys: [funder, server] }).script
    const cancel = MultisigTapscript.encode({ pubkeys: [funder, claimer, server] }).script
    const uexit = CSVMultisigTapscript.encode({
      timelock: { type: exitDelay >= 512n ? 'seconds' : 'blocks', value: exitDelay },
      pubkeys: [funder],
    }).script
    super([claim, refund, cancel, uexit])
    this.claimHex = toHex(claim)
  }
  claim() {
    return this.findLeaf(this.claimHex)
  }
}

// Wallet-free address derivation (α: boltz uses SingleKey + DefaultVtxo, no Wallet).
function defaultAddress(xonly, serverXOnly, exitDelay) {
  const script = new DefaultVtxo.Script({
    pubKey: xonly,
    serverPubKey: serverXOnly,
    csvTimelock: { type: exitDelay >= 512n ? 'seconds' : 'blocks', value: exitDelay },
  })
  return script.address(HRP, serverXOnly)
}

// boltz reveals the preimage on every input it signs (claim leaf = ConditionMultisig).
function withPreimage(identity, preimage) {
  return {
    ...identity,
    sign: async (tx, idx) => {
      let signed = await identity.sign(tx, idx)
      signed = Transaction.fromPSBT(signed.toPSBT())
      const indexes = idx || Array.from({ length: signed.inputsLength }, (_, i) => i)
      for (const i of indexes) setArkPsbtField(signed, i, ConditionWitness, [preimage])
      return signed
    },
  }
}

async function main() {
  console.log('atomic sub-dust boltz-side PoC (#03) — Node', process.version, 'CJS require()\n')

  // ── α gate: does the SDK load + function in boltz's runtime? ──
  check(typeof buildOffchainTx === 'function' && typeof SingleKey === 'function', 'require(@arkade-os/sdk) loaded under Node CJS')

  const ark = new RestArkProvider(ARKD_URL)
  const indexer = new RestIndexerProvider(ARKD_URL)
  const info = await ark.getInfo()
  const serverXOnly = toXOnly(fromHex(info.signerPubkey))
  const unroll = CSVMultisigTapscript.decode(fromHex(info.checkpointTapscript))
  const dust = Number(info.dust)
  const d = info.unilateralExitDelay
  check(!!info.signerPubkey && dust > 0, `boltz fetched arkd params (getInfo): dust=${dust}, d=${d}, net=${info.network}`)

  // boltz = C (claimer, key-only). F = presigner (funded by the regtest client).
  const boltz = SingleKey.fromPrivateKey(crypto.randomBytes(32))
  const boltzXOnly = toXOnly(await boltz.xOnlyPublicKey())
  const F = SingleKey.fromPrivateKey(crypto.randomBytes(32))
  const fXOnly = toXOnly(await F.xOnlyPublicKey())
  const boltzAddr = defaultAddress(boltzXOnly, serverXOnly, d)
  const fAddr = defaultAddress(fXOnly, serverXOnly, d)
  check(!!boltzAddr.encode(), `boltz derived its receive address without a Wallet (${boltzAddr.encode().slice(0, 16)}…)`)

  const preimage = crypto.randomBytes(32)
  const H = sha256(preimage)
  const T = BigInt(Math.floor(Date.now() / 1000)) + 3600n
  const script = new AtomicSubdustScript(fXOnly, boltzXOnly, serverXOnly, H, T, d)
  const sharedAddr = script.address(HRP, serverXOnly).encode()
  const sharedPk = toHex(script.pkScript)

  // Fund the shared vtxo via the regtest ark client (any party can pay it).
  const V = 1000
  const a = Math.max(Number(info.vtxoMinAmount), 21) // 21-sat zap, sub-dust
  console.log(`\nfunding shared 4-leaf vtxo V=${V} (a=${a} to boltz, change ${V - a} to F)…`)
  regtest('ark', 'send', '--to', sharedAddr, '--amount', String(V), '--password', ARK_PW)
  regtest('mine', '1')
  let shared
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [sharedPk], spendableOnly: true })
    const v = vtxos.find((x) => x.value === V)
    if (v) {
      shared = { txid: v.txid, vout: v.vout, value: v.value, tapLeafScript: script.claim(), tapTree: script.encode() }
      break
    }
    await sleep(500)
  }
  if (!shared) throw new Error('shared vtxo never appeared')
  check(true, `shared vtxo funded ${shared.txid.slice(0, 12)}…:${shared.vout}`)

  // Split outputs: a (sub-dust OP_RETURN) to boltz, change (regular) to F.
  const outputs = [
    { script: boltzAddr.subdustPkScript, amount: BigInt(a) },
    { script: fAddr.pkScript, amount: BigInt(V - a) },
  ]

  // ── F presigns the claim pair (the "2 presigs"). ──
  const built = buildOffchainTx([shared], outputs, unroll)
  const [checkpoint] = built.checkpoints
  const arkFromF = await F.sign(built.arkTx)
  const ckptFromF = await F.sign(checkpoint)
  const presig = { ark: toB64(arkFromF.toPSBT()), ckpt: toB64(ckptFromF.toPSBT()) }
  check(!!presig.ark && !!presig.ckpt, 'F produced 2 presigs (arkTx + checkpoint), then goes offline')

  // ── boltz (C, key-only) claims: rebuild deterministically, add its sig +
  //    preimage, combine F's presig, submit (server co-signs), finalize. ──
  console.log('\nboltz (Node CJS process) signs + submits the claim…')
  const rebuilt = buildOffchainTx([shared], outputs, unroll)
  const [ckptRebuilt] = rebuilt.checkpoints
  const fArk = Transaction.fromPSBT(fromB64(presig.ark))
  const fCkpt = Transaction.fromPSBT(fromB64(presig.ckpt))
  check(fArk.id === rebuilt.arkTx.id && fCkpt.id === ckptRebuilt.id, 'boltz verified F presig txids == deterministic rebuild (verify-before-act)')

  const boltzSigner = withPreimage(boltz, preimage)
  const arkC = await boltzSigner.sign(rebuilt.arkTx)
  combineTapscriptSigs(fArk, arkC) // arkC now boltz + F sigs + preimage
  const ckptC = await boltzSigner.sign(ckptRebuilt, [0])
  combineTapscriptSigs(fCkpt, ckptC) // ckptC now boltz + F sigs + preimage

  const { arkTxid, signedCheckpointTxs } = await ark.submitTx(toB64(arkC.toPSBT()), [toB64(ckptRebuilt.toPSBT())])
  const [serverCkptB64] = signedCheckpointTxs
  const serverCkpt = Transaction.fromPSBT(fromB64(serverCkptB64))
  combineTapscriptSigs(serverCkpt, ckptC) // + server sig
  await ark.finalizeTx(arkTxid, [toB64(ckptC.toPSBT())])
  check(!!arkTxid, `boltz submitTx + finalizeTx succeeded (arkTxid ${arkTxid.slice(0, 12)}…) — SIGN+SUBMIT in boltz runtime`)

  // boltz should now own the sub-dust a as a recoverable vtxo.
  const boltzPk = toHex(boltzAddr.pkScript)
  let got = false
  for (let i = 0; i < 20; i++) {
    const { vtxos } = await indexer.getVtxos({ scripts: [boltzPk], recoverableOnly: true })
    if (vtxos.some((v) => v.value === a && !v.isSpent)) {
      got = true
      break
    }
    await sleep(500)
  }
  check(got, `boltz received the sub-dust a=${a} (recoverable vtxo) — send-side claim complete`)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`verdict: ${PASS} passed, ${FAIL} failed`)
  console.log(
    FAIL === 0
      ? '✅ α CONFIRMED — @arkade-os/sdk works in a boltz-shaped Node CJS process;\n   boltz signed + submitted the claim key-only (no Wallet). Strategy: embed the SDK.'
      : '❌ FAILURES — see above',
  )
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nspike crashed:', e)
  process.exit(1)
})
