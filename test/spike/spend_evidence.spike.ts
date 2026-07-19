// Spike — evidence-gated GC (exit/evidence-gc): can a disappeared vtxo's
// legitimate spend be PROVEN from indexer data, keyed on our own pubkey?
//
// The bet behind evidence-gated GC: every legitimate way a vtxo leaves the
// live set produces something the indexer can serve and we can verify
// locally:
//   1. offchain spend  → getVtxos({scripts, spentOnly}) rows carry spentBy
//      (checkpoint txid); getVirtualTxs([spentBy]) returns a PSBT whose
//      input spends our outpoint and whose signature verifies against OUR
//      x-only pubkey (any wallet holding the nsec — covers the
//      same-key-imported-elsewhere case)
//   2. settlement      → settledBy (commitment txid) + forfeit txs
//   3. expiry sweep    → no user signature, judged locally from expiresAt
//
// Probes 1 (and inventories 2/3), then attempts schnorr verification of the
// spending signature — including a negative control (foreign pubkey MUST
// fail, otherwise the check is theater).
//
// Modes:
//   bun test/spike/spend_evidence.spike.ts --regtest
//       self-contained drill against the local arkade-regtest stack
//       (regtest-e2e/up.sh must be up): mint a throwaway wallet, fund it
//       from the seeded ark client, spend offchain, then probe the spent
//       vtxo's evidence. No real funds anywhere near this.
//   bun test/spike/spend_evidence.spike.ts [--db <path>]
//       read-only inventory against mainnet using the bridge account's
//       script (run on the machine that holds the funded bridge db).
//       Nothing is signed, broadcast or settled.
//
// Polyfills footgun (@noble/@scure ESM warming): import '../../src/polyfills' first.

import '../../src/polyfills'
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  InMemoryContractRepository,
  InMemoryWalletRepository,
  ReadonlyWallet,
  RestIndexerProvider,
  SingleKey,
  Transaction,
  Wallet,
  type Outpoint,
  type VirtualCoin,
} from '@arkade-os/sdk'
import { loadAccount } from '../../src/account'
import { ARK_SERVER_URL } from '../../src/defaults'

const MAX_PAGES = 50

const REGTEST_ARKD = 'http://localhost:7070'
const REGTEST_ESPLORA = 'http://localhost:3000/api'

function resolveDbPath(explicit?: string): string {
  const candidates = explicit
    ? [explicit]
    : ['./data/bridge.sqlite', '../../data/bridge.sqlite']
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(`bridge sqlite not found (tried ${candidates.join(', ')}) — pass --db <path>`)
}

// Same discovery ladder as regtest-e2e/env.sh (normal checkout + worktree).
function resolveRegtestDir(): string {
  const repo = join(import.meta.dir, '..', '..')
  const candidates = [
    process.env.REGTEST_DIR,
    join(repo, '..', 'ts-sdk', 'regtest'),
    join(repo, '..', '..', '..', 'ts-sdk', 'regtest'),
    join(repo, '..', '..', 'ts-sdk', 'regtest'),
  ].filter((c): c is string => !!c)
  for (const c of candidates) {
    if (existsSync(join(c, 'regtest.mjs'))) return c
  }
  throw new Error('arkade-regtest not found — set REGTEST_DIR')
}

function regtestCli(dir: string, args: string[]): string {
  const res = Bun.spawnSync(['node', 'regtest.mjs', ...args], { cwd: dir })
  const out = res.stdout.toString()
  if (res.exitCode !== 0) {
    throw new Error(`regtest.mjs ${args.join(' ')} failed: ${res.stderr.toString() || out}`)
  }
  return out
}

async function pagedVtxos(
  indexer: RestIndexerProvider,
  opts: Record<string, unknown>,
): Promise<VirtualCoin[]> {
  const seen = new Map<string, VirtualCoin>()
  let pageIndex = 0
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await indexer.getVtxos({ ...(opts as object), pageIndex, pageSize: 100 } as never)
    for (const v of res.vtxos) seen.set(`${v.txid}:${v.vout}`, v)
    if (!res.page || res.page.next <= res.page.current) break
    pageIndex = res.page.next
  }
  return [...seen.values()]
}

async function fetchPsbts(
  indexer: RestIndexerProvider,
  txids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (txids.length === 0) return out
  let pageIndex = 0
  const collected: string[] = []
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await indexer.getVirtualTxs(txids, { pageIndex, pageSize: 100 })
    collected.push(...res.txs)
    if (!res.page || res.page.next <= res.page.current) break
    pageIndex = res.page.next
  }
  for (const psbtB64 of collected) {
    const tx = Transaction.fromPSBT(base64.decode(psbtB64))
    out.set(tx.id, psbtB64)
  }
  return out
}

function outpointOf(v: { txid: string; vout: number }): string {
  return `${v.txid}:${v.vout}`
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function pollUntil<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 60_000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const got = await fn()
    if (got !== null) return got
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(1_500)
  }
}

/** Phase A+B over one script: field inventory, then per-spentBy signature probe. */
async function probe(
  indexer: RestIndexerProvider,
  script: string,
  ourXOnly: string,
): Promise<void> {
  const spent = await pagedVtxos(indexer, { scripts: [script], spentOnly: true })
  console.log(`\nspent vtxos returned: ${spent.length}`)
  const dist = new Map<string, number>()
  const bump = (k: string) => dist.set(k, (dist.get(k) ?? 0) + 1)
  for (const v of spent) {
    if (v.spentBy) bump('spentBy set')
    if ((v as { arkTxId?: string }).arkTxId) bump('arkTxId set')
    if (v.settledBy) bump('settledBy set')
    if (v.isSpent) bump('isSpent true')
    bump(`state=${v.virtualStatus?.state}`)
    if (v.spentBy && v.settledBy) bump('BOTH spentBy+settledBy')
  }
  for (const [k, n] of [...dist.entries()].sort()) console.log(`  ${k}: ${n}`)

  // outpoint-keyed lookup — the GC path holds a vanished outpoint, not a
  // script query, so this shape must work too
  const sample = spent.find((v) => v.spentBy) ?? spent[0]
  if (!sample) {
    console.log('no spent vtxos — nothing further to probe')
    return
  }
  const byOutpoint = await indexer.getVtxos({
    outpoints: [{ txid: sample.txid, vout: sample.vout } as Outpoint],
  })
  console.log(
    `outpoint lookup ${outpointOf(sample)}: ${byOutpoint.vtxos.length} row(s), ` +
      `spentBy=${byOutpoint.vtxos[0]?.spentBy ?? '∅'} settledBy=${byOutpoint.vtxos[0]?.settledBy ?? '∅'} ` +
      `state=${byOutpoint.vtxos[0]?.virtualStatus?.state}`,
  )

  for (const v of spent.filter((x) => x.spentBy).slice(0, 3)) {
    console.log(`\n═══ ${outpointOf(v)} value=${v.value} spentBy=${v.spentBy}`)
    const psbts = await fetchPsbts(indexer, [v.spentBy!])
    const psbtB64 = psbts.get(v.spentBy!)
    if (!psbtB64) {
      console.log(`  ✗ getVirtualTxs did NOT serve ${v.spentBy}`)
      continue
    }
    const tx = Transaction.fromPSBT(base64.decode(psbtB64))
    console.log(`  psbt served: ${tx.inputsLength} in / ${tx.outputsLength} out`)

    let inputIdx = -1
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i)
      if (inp.txid && hex.encode(inp.txid) === v.txid && inp.index === v.vout) inputIdx = i
    }
    if (inputIdx < 0) {
      console.log(`  ✗ no input spends our outpoint — spentBy tx does not consume it?!`)
      continue
    }
    const inp = tx.getInput(inputIdx)
    console.log(`  input[${inputIdx}] spends our outpoint`)
    console.log(
      `    witnessUtxo: ${inp.witnessUtxo ? `${inp.witnessUtxo.amount} sat, script ${hex.encode(inp.witnessUtxo.script)}` : '∅'}`,
    )
    console.log(
      `    finalScriptWitness: ${inp.finalScriptWitness ? inp.finalScriptWitness.map((w) => `${w.length}B`).join(',') : '∅'}`,
    )
    console.log(`    tapLeafScript entries: ${inp.tapLeafScript?.length ?? 0}`)
    for (const [pub, sig] of inp.tapScriptSig ?? []) {
      const isOurs = hex.encode(pub.pubKey) === ourXOnly
      console.log(
        `    tapScriptSig pub=${hex.encode(pub.pubKey).slice(0, 16)}… leaf=${hex.encode(pub.leafHash).slice(0, 16)}… sig=${sig.length}B ${isOurs ? '← OURS' : ''}`,
      )
    }

    const leaf = inp.tapLeafScript?.[0]
    const ourSig = (inp.tapScriptSig ?? []).find(([p]) => hex.encode(p.pubKey) === ourXOnly)?.[1]
    if (!leaf || !ourSig) {
      console.log('  (no labelled sig+leaf in psbt fields — witness-stack parsing would be needed)')
      continue
    }
    const [, leafScript] = leaf
    let prevoutsOk = true
    for (let i = 0; i < tx.inputsLength; i++) {
      if (!tx.getInput(i).witnessUtxo) prevoutsOk = false
    }
    if (!prevoutsOk) {
      console.log('  ✗ some inputs lack witnessUtxo — sighash not computable from psbt alone')
      continue
    }
    const sigHashType = ourSig.length === 65 ? ourSig[64]! : 0x00 // DEFAULT
    const sig64 = ourSig.slice(0, 64)
    // tapLeafScript value = script || leafVer (1 trailing byte) — same
    // split btc-signer's own signIdx does
    const scriptBytes = leafScript.subarray(0, leafScript.length - 1)
    const leafVer = leafScript[leafScript.length - 1]!
    try {
      const preimage = tx.preimageWitnessV1(
        inputIdx,
        Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).witnessUtxo!.script),
        sigHashType,
        Array.from({ length: tx.inputsLength }, (_, i) => BigInt(tx.getInput(i).witnessUtxo!.amount)),
        undefined,
        scriptBytes,
        leafVer,
      )
      const ok = schnorr.verify(sig64, preimage, hex.decode(ourXOnly))
      console.log(`  schnorr verify vs OUR pubkey:     ${ok ? '✓ VALID' : '✗ INVALID'}`)
      // negative control: a foreign key must NOT verify
      const foreign = schnorr.getPublicKey(new Uint8Array(32).fill(7))
      const bad = schnorr.verify(sig64, preimage, foreign)
      console.log(
        `  schnorr verify vs foreign pubkey: ${bad ? '✗ VALID (BROKEN CHECK!)' : '✓ invalid as expected'}`,
      )
    } catch (err) {
      console.log(`  ✗ sighash/verify threw: ${err instanceof Error ? err.message : err}`)
    }
  }

  const settledOnly = spent.filter((v) => v.settledBy && !v.spentBy).slice(0, 2)
  console.log(
    `\nsettledBy-only samples (forfeit path, phase 2): ${settledOnly.map(outpointOf).join(', ') || 'none'}`,
  )
  const swept = spent.filter((v) => v.virtualStatus?.state === 'swept').length
  console.log(`swept-state rows (expiry path, judged locally): ${swept}`)
}

async function regtestDrill(): Promise<void> {
  const regtestDir = resolveRegtestDir()
  console.log(`regtest dir: ${regtestDir}`)

  const privateKey = crypto.getRandomValues(new Uint8Array(32))
  const identity = SingleKey.fromPrivateKey(privateKey)
  const ourXOnly = hex.encode(await identity.xOnlyPublicKey())
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: REGTEST_ARKD,
    esploraUrl: REGTEST_ESPLORA,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
    // don't let auto-renew consume the vtxo mid-drill
    settlementConfig: { vtxoThreshold: 3600 },
  })
  const address = await wallet.getAddress()
  const script = wallet.defaultContractScript
  const indexer = new RestIndexerProvider(REGTEST_ARKD)
  console.log(`throwaway wallet: ${address}`)
  console.log(`our x-only pubkey: ${ourXOnly}`)

  console.log('\nfunding 50k sats from the seeded ark client…')
  regtestCli(regtestDir, [
    'ark',
    'send',
    '--to',
    address,
    '--amount',
    '50000',
    '--password',
    'secret',
  ])
  regtestCli(regtestDir, ['mine', '1'])
  await pollUntil('funding vtxo to appear', async () => {
    const live = await pagedVtxos(indexer, { scripts: [script], spendableOnly: true })
    return live.length > 0 ? live : null
  })
  console.log('funded.')

  const receive = JSON.parse(regtestCli(regtestDir, ['ark', 'receive'])) as {
    offchain_address: string
  }
  console.log(`\nspending 20k sats offchain back to the ark client…`)
  const spendTxid = await wallet.send({ address: receive.offchain_address, amount: 20_000 })
  console.log(`sent — arkTxid ${spendTxid}`)

  await pollUntil('spent vtxo to be indexed', async () => {
    const spent = await pagedVtxos(indexer, { scripts: [script], spentOnly: true })
    return spent.length > 0 ? spent : null
  })

  await probe(indexer, script, ourXOnly)

  // phase C: settle the change vtxo → what evidence shape does a
  // settlement leave on the pre-settle outpoint? (forfeit path inventory)
  console.log('\nphase C: settling remaining vtxos (round)…')
  const preSettle = await pagedVtxos(indexer, { scripts: [script], spendableOnly: true })
  try {
    const commitmentTxid = await wallet.settle()
    console.log(`settled — commitment ${commitmentTxid}`)
    regtestCli(regtestDir, ['mine', '1'])
    await sleep(3_000)
    for (const v of preSettle) {
      const after = await indexer.getVtxos({ outpoints: [{ txid: v.txid, vout: v.vout }] })
      const row = after.vtxos[0]
      console.log(
        `  pre-settle ${outpointOf(v)} → spentBy=${row?.spentBy ?? '∅'} settledBy=${row?.settledBy ?? '∅'} ` +
          `arkTxId=${(row as { arkTxId?: string } | undefined)?.arkTxId ?? '∅'} state=${row?.virtualStatus?.state} isSpent=${row?.isSpent}`,
      )
    }
  } catch (err) {
    console.log(
      `settle failed (non-fatal for the spike): ${err instanceof Error ? err.message : err}`,
    )
  }

  // re-probe: does the settle-consumed vtxo's spentBy tx ALSO verify via the
  // same pubkey-labelled route? If yes, evidence classes 1 and 2 unify.
  console.log('\nre-probe after settle:')
  await probe(indexer, script, ourXOnly)

  await wallet.dispose()
}

async function mainnetInventory(): Promise<void> {
  const dbArg = process.argv.indexOf('--db')
  const dbPath = resolveDbPath(dbArg >= 0 ? process.argv[dbArg + 1] : undefined)

  const db = new Database(dbPath, { readonly: true })
  const account = loadAccount(db)
  db.close()
  if (!account) throw new Error(`no account row in ${dbPath}`)

  const identity = SingleKey.fromPrivateKey(account.privateKey)
  const ourXOnly = hex.encode(await identity.xOnlyPublicKey())
  const wallet = await ReadonlyWallet.create({
    identity,
    arkServerUrl: ARK_SERVER_URL,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
  })
  console.log(`our x-only pubkey: ${ourXOnly}`)
  console.log(`wallet script:     ${wallet.defaultContractScript}`)
  await probe(new RestIndexerProvider(ARK_SERVER_URL), wallet.defaultContractScript, ourXOnly)
}

if (process.argv.includes('--regtest')) {
  await regtestDrill()
} else {
  await mainnetInventory()
}
process.exit(0)
