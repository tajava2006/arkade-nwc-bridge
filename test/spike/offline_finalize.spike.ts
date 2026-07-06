// Spike #02 (EXIT_PLAN.md §5) — can exit txs be finalized OFFLINE from
// locally stored proofs?
//
// The exit engine's core bet: `Unroll.Session` needs the indexer for exactly
// one thing — `getVirtualTxs` PSBTs — and those PSBTs already carry every
// signature finalization needs (TREE: musig2 tapKeySig from the round;
// ARK/CHECKPOINT: complete witnesses for `tx.finalize()`). If that holds, a
// sqlite-backed stub indexer makes the whole SDK unroll path work with the
// ASP dead. This spike proves or kills the bet before any vault/engine code
// is written.
//
// What it does (read-only against mainnet; nothing is broadcast, signed or
// settled):
//   1. open the production bridge sqlite READONLY, load the account key
//   2. list current VTXOs straight from the indexer (getVtxos by script).
//      ReadonlyWallet is used ONLY to derive the wallet script: it cannot
//      sign (→ cannot trigger settlementConfig auto-renewal like a full
//      Wallet), and its own getVtxos reads repositories which are empty
//      without a running ContractManager — repo-first is useless here
//   3. for every vtxo: fetch its chain + all non-commitment PSBTs from the
//      indexer, dump everything to data/exit-spike/ (gitignored — mainnet
//      txids identify the wallet, so dumps must never be committed)
//   4. OFFLINE phase: for every unique tx, replay Session's finalize rules
//      (unroll.ts) and check the P2A anchor output is present
//   5. integration: construct a real Unroll.Session over the dump with stub
//      indexer + stub bumper + stub explorer and call next() — but never
//      step.do(). NOTE: the stub bumper is not just about fees — the real
//      OnchainWallet.bumpP2A BROADCASTS inside itself (onchain.ts), so a
//      dry-run must never hand Session a real bumper.
//   6. print dedup/size stats (vault schema sizing) and a per-tx report
//
// Modes:
//   bun test/spike/offline_finalize.spike.ts [--db <path>]  fetch + verify
//   bun ... --address <ark1…>     same, but skip the db/key entirely and
//                                 derive the script from the address — the
//                                 chain/PSBT endpoints are public indexer
//                                 data, so a dashboard-copied address is all
//                                 the spike needs (useful when the funded
//                                 bridge runs on another machine)
//   bun ... --replay <dumpfile>   offline phase only, no network/DB — run
//                                 this after every SDK bump (update-refs /
//                                 bun run upgrade) as a regression check
//   bun ... --watch [--db <path>] passive timing probe: poll the vtxo set,
//                                 on change measure how long until proofs
//                                 are fetchable+finalizable (informs the
//                                 ProofSync retry backoff, EXIT_PLAN #04)
//
// Not a bun:test file: it needs live mainnet reads and the production db.
//
// Footgun (observed once, cold transpiler cache): importing the SDK without
// src/polyfills first can crash bun 1.3 inside @bitcoinerlab's CJS adapter
// ("require() async module @noble/curves"). Every bridge entrypoint already
// imports polyfills first; this file must keep doing the same.

import '../../src/polyfills'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { base64, hex } from '@scure/base'
import {
  ArkAddress,
  ChainTxType,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  ReadonlyWallet,
  RestIndexerProvider,
  SingleKey,
  Transaction,
  Unroll,
  type AnchorBumper,
  type ChainTx,
  type IndexerProvider,
  type OnchainProvider,
  type Outpoint,
  type VirtualCoin,
} from '@arkade-os/sdk'
import { loadAccount } from '../../src/account'
import { ARK_SERVER_URL } from '../../src/defaults'

const ANCHOR_SCRIPT_HEX = '51024e73' // zero-value P2A, same bytes arkd emits

interface Dump {
  fetchedAt: string
  arkServerUrl: string
  vtxos: {
    outpoint: Outpoint
    value: number
    virtualStatus: unknown
    chain: ChainTx[]
  }[]
  // unique across all vtxo chains — this dedup IS the vault storage model
  txs: Record<string, { type: ChainTxType; psbtB64: string }>
}

function resolveDbPath(explicit?: string): string {
  const candidates = explicit
    ? [explicit]
    : ['./data/bridge.sqlite', '../../data/bridge.sqlite']
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(
    `bridge sqlite not found (tried ${candidates.join(', ')}) — pass --db <path>`,
  )
}

// PageResponse's last-page sentinel isn't documented; treat "next doesn't
// advance" or a missing page object as done, and cap iterations so a
// surprising sentinel can't loop forever. Nail the exact contract in #04.
const MAX_PAGES = 50

async function fetchChain(indexer: RestIndexerProvider, outpoint: Outpoint): Promise<ChainTx[]> {
  const chain: ChainTx[] = []
  let pageIndex = 0
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await indexer.getVtxoChain(outpoint, { pageIndex, pageSize: 100 })
    chain.push(...res.chain)
    if (!res.page || res.page.next <= res.page.current) break
    pageIndex = res.page.next
  }
  return chain
}

async function fetchVirtualTxs(
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
  // response order mirrors request order; map back by decoding each PSBT's
  // txid so a server that reorders can't silently mislabel a proof
  for (const psbtB64 of collected) {
    const tx = Transaction.fromPSBT(base64.decode(psbtB64))
    out.set(tx.id, psbtB64)
  }
  return out
}

// Spendable and recoverable (sub-dust) are both exit-relevant: a sub-dust
// vtxo can't clear a sweep fee alone but rides along in a batched sweep.
async function listLiveVtxos(
  indexer: RestIndexerProvider,
  script: string,
): Promise<VirtualCoin[]> {
  const seen = new Map<string, VirtualCoin>()
  for (const filter of [{ spendableOnly: true }, { recoverableOnly: true }]) {
    let pageIndex = 0
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await indexer.getVtxos({
        scripts: [script],
        ...filter,
        pageIndex,
        pageSize: 100,
      })
      for (const v of res.vtxos) seen.set(`${v.txid}:${v.vout}`, v)
      if (!res.page || res.page.next <= res.page.current) break
      pageIndex = res.page.next
    }
  }
  return [...seen.values()]
}

async function walletScript(dbPath: string): Promise<string> {
  const db = new Database(dbPath, { readonly: true })
  const account = loadAccount(db)
  db.close()
  if (!account) throw new Error(`no account row in ${dbPath}`)
  const identity = SingleKey.fromPrivateKey(account.privateKey)
  const wallet = await ReadonlyWallet.create({
    identity,
    arkServerUrl: ARK_SERVER_URL,
    storage: {
      walletRepository: new InMemoryWalletRepository(),
      contractRepository: new InMemoryContractRepository(),
    },
  })
  // Primary offchain script only — the bridge is a static SingleKey wallet
  // (no receive rotation / delegate contracts), so one script covers it.
  return wallet.defaultContractScript
}

async function buildDump(source: { db?: string; address?: string }): Promise<Dump> {
  const indexer = new RestIndexerProvider(ARK_SERVER_URL)
  const script = source.address
    ? hex.encode(ArkAddress.decode(source.address).pkScript)
    : await walletScript(resolveDbPath(source.db))
  const vtxos = await listLiveVtxos(indexer, script)
  console.log(`wallet has ${vtxos.length} live vtxo(s) on script ${script.slice(0, 16)}…\n`)
  const dump: Dump = {
    fetchedAt: new Date().toISOString(),
    arkServerUrl: ARK_SERVER_URL,
    vtxos: [],
    txs: {},
  }

  for (const v of vtxos) {
    const outpoint = { txid: v.txid, vout: v.vout }
    const chain = await fetchChain(indexer, outpoint)
    dump.vtxos.push({ outpoint, value: v.value, virtualStatus: v.virtualStatus, chain })

    const wanted = chain
      .filter((c) => c.type !== ChainTxType.COMMITMENT && c.type !== ChainTxType.UNSPECIFIED)
      .map((c) => c.txid)
      .filter((txid) => !(txid in dump.txs))
    const fetched = await fetchVirtualTxs(indexer, wanted)
    for (const c of chain) {
      const psbtB64 = fetched.get(c.txid)
      if (psbtB64) dump.txs[c.txid] = { type: c.type, psbtB64 }
    }
    const missing = wanted.filter((txid) => !(txid in dump.txs))
    if (missing.length > 0) {
      console.warn(`  ⚠ ${v.txid}:${v.vout} — ${missing.length} chain tx(s) not returned: ${missing.join(', ')}`)
    }
  }
  return dump
}

// Mirrors Unroll.Session.next()'s finalize rules — the exact code path the
// engine will rely on. If this diverges from the SDK after a bump, the
// --replay regression run fails here first.
function finalizeLikeSession(type: ChainTxType, psbtB64: string): Transaction {
  const tx = Transaction.fromPSBT(base64.decode(psbtB64))
  if (type === ChainTxType.TREE) {
    const input = tx.getInput(0)
    if (!input) throw new Error('input 0 not found')
    if (!input.tapKeySig) throw new Error('tapKeySig missing — tree tx not round-signed?')
    tx.updateInput(0, { finalScriptWitness: [input.tapKeySig] })
  } else {
    tx.finalize()
  }
  return tx
}

function hasAnchorOutput(tx: Transaction): boolean {
  for (let i = 0; i < tx.outputsLength; i++) {
    const script = tx.getOutput(i)?.script
    if (script && hex.encode(script) === ANCHOR_SCRIPT_HEX) return true
  }
  return false
}

function offlinePhase(dump: Dump): boolean {
  console.log('— offline finalize check (no network) —')
  let pass = 0
  let fail = 0
  const chainRefs = dump.vtxos.reduce((n, v) => n + v.chain.length, 0)
  for (const [txid, { type, psbtB64 }] of Object.entries(dump.txs)) {
    try {
      const tx = finalizeLikeSession(type, psbtB64)
      const anchor = hasAnchorOutput(tx)
      const vsize = tx.vsize
      console.log(
        `  ok   ${type.replace('INDEXER_CHAINED_TX_TYPE_', '').padEnd(10)} ${txid.slice(0, 16)}… vsize=${String(vsize).padStart(4)} anchor=${anchor ? 'yes' : 'NO ⚠'}`,
      )
      pass++
    } catch (err) {
      console.log(`  FAIL ${txid}: ${err instanceof Error ? err.message : err}`)
      fail++
    }
  }
  const unique = Object.keys(dump.txs).length
  const bytes = Object.values(dump.txs).reduce((n, t) => n + t.psbtB64.length, 0)
  console.log(`\n  ${pass} finalized, ${fail} failed`)
  console.log(
    `  dedup: ${chainRefs} chain refs → ${unique} unique txs across ${dump.vtxos.length} vtxo(s)`,
  )
  console.log(`  proof size: ${(bytes / 1024).toFixed(1)} KB (base64)\n`)
  return fail === 0
}

async function sessionPhase(dump: Dump): Promise<boolean> {
  console.log('— Unroll.Session integration (stub indexer/bumper/explorer, next() only) —')
  const stubIndexer = {
    getVirtualTxs: async (txids: string[]) => ({
      txs: txids.map((id) => {
        const t = dump.txs[id]
        if (!t) throw new Error(`tx ${id} not in dump`)
        return t.psbtB64
      }),
    }),
  } as unknown as IndexerProvider
  // real bumpP2A broadcasts inside itself — a dry run must never see it
  const stubBumper: AnchorBumper = {
    bumpP2A: async (parent: Transaction) => [parent.hex, '<child-not-built-in-dry-run>'],
  }
  // every virtual tx reads as "not found" = nothing broadcast yet; also keeps
  // the dry run off the network entirely
  const stubExplorer = {
    getTxStatus: async () => {
      throw new Error('not found (stub explorer: nothing broadcast)')
    },
  } as unknown as OnchainProvider

  let allOk = true
  for (const v of dump.vtxos) {
    try {
      const session = new Unroll.Session(
        { ...v.outpoint, chain: v.chain },
        stubBumper,
        stubExplorer,
        stubIndexer,
      )
      const step = await session.next()
      if (step.type !== Unroll.StepType.UNROLL) {
        console.log(`  ⚠ ${v.outpoint.txid.slice(0, 16)}… unexpected step type ${step.type}`)
        allOk = false
        continue
      }
      console.log(
        `  ok   ${v.outpoint.txid.slice(0, 16)}… next() → UNROLL of ${step.tx.id.slice(0, 16)}… (${step.tx.hex.length / 2} bytes, finalized)`,
      )
    } catch (err) {
      console.log(`  FAIL ${v.outpoint.txid.slice(0, 16)}…: ${err instanceof Error ? err.message : err}`)
      allOk = false
    }
  }
  console.log()
  return allOk
}

async function watchMode(source: { db?: string; address?: string }): Promise<void> {
  console.log('watch mode — trigger a send/receive/settle from the bridge, ctrl-c to stop')
  const indexer = new RestIndexerProvider(ARK_SERVER_URL)
  const script = source.address
    ? hex.encode(ArkAddress.decode(source.address).pkScript)
    : await walletScript(resolveDbPath(source.db))
  const seen = new Set(
    (await listLiveVtxos(indexer, script)).map((v) => `${v.txid}:${v.vout}`),
  )
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000))
    const vtxos = await listLiveVtxos(indexer, script)
    for (const v of vtxos) {
      const key = `${v.txid}:${v.vout}`
      if (seen.has(key)) continue
      seen.add(key)
      const t0 = Date.now()
      console.log(`new vtxo ${key} — polling until proofs are finalizable…`)
      for (let attempt = 1; ; attempt++) {
        try {
          const chain = await fetchChain(indexer, { txid: v.txid, vout: v.vout })
          const wanted = chain
            .filter((c) => c.type !== ChainTxType.COMMITMENT && c.type !== ChainTxType.UNSPECIFIED)
            .map((c) => c.txid)
          const txs = await fetchVirtualTxs(indexer, wanted)
          for (const id of wanted) {
            const psbtB64 = txs.get(id)
            if (!psbtB64) throw new Error(`tx ${id} not served yet`)
            finalizeLikeSession(chain.find((c) => c.txid === id)!.type, psbtB64)
          }
          console.log(`  complete after ${((Date.now() - t0) / 1000).toFixed(1)}s (attempt ${attempt})`)
          break
        } catch (err) {
          console.log(`  attempt ${attempt}: ${err instanceof Error ? err.message : err}`)
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }

  const source = { db: flag('--db'), address: flag('--address') }

  if (args.includes('--watch')) {
    await watchMode(source)
    return
  }

  let dump: Dump
  const replayPath = flag('--replay')
  if (replayPath) {
    dump = JSON.parse(readFileSync(replayPath, 'utf8')) as Dump
    console.log(`replaying dump ${replayPath} (fetched ${dump.fetchedAt})\n`)
  } else {
    dump = await buildDump(source)
    const outDir = 'data/exit-spike'
    mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, `dump-${Date.now()}.json`)
    writeFileSync(outPath, JSON.stringify(dump, null, 1))
    console.log(`dump written to ${outPath} (do NOT commit — identifies the wallet)\n`)
  }

  const offlineOk = offlinePhase(dump)
  const sessionOk = await sessionPhase(dump)

  console.log(
    offlineOk && sessionOk
      ? 'verdict: stored PSBTs finalize offline and drive Unroll.Session — vault design viable'
      : 'verdict: FAILURES above — vault design needs rework before building #03+',
  )
  process.exit(offlineOk && sessionOk ? 0 : 1)
}

main()
