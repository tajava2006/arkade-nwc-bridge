// Re-ask the LIVE indexer for each vault vtxo's chain and diff it against the
// stored one.
//
// check-exit-chains finds chains with missing ancestry; this decides WHY, which
// is the only thing that picks the fix:
//
//   * the live chain CLOSES  -> the vault froze a bad capture; the bridge's own
//     re-fetch (proof_sync) repairs it on the next pass.
//   * the live chain is ALSO broken -> the indexer's walk cannot produce a
//     closed chain (it drops parent VTXOs it fails to resolve without
//     erroring), so re-fetching every pass changes nothing and the vtxo is not
//     unilaterally exitable at all.
//
// The verdict is deliberately about the WHOLE live chain, not about the one
// parent the stored orphan happens to name: pulling that ancestor in moves the
// boundary, and the newly included tx has a parent of its own that may be the
// next thing missing. An earlier version of this script asked the narrow
// question and reported "NOW SERVED" for a chain that was still broken.
//
// Read-only against sqlite AND the indexer — it fetches and compares, it never
// writes. Repairing is a separate, deliberate step.
//
// Usage:
//   bun run recheck-exit-chain [db.sqlite] [--url http://arkd:7070] [--outpoint txid:vout]
import '../src/polyfills'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { RestIndexerProvider, type ChainTx } from '@arkade-os/sdk'
import { loadConfig } from '../src/config'
import { resolveServerSet } from '../src/server_config'
import { listVaultVtxos } from '../src/exit/vault'
import { danglingEntries } from '../src/exit/chain_order'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))

const dbPath = positional[0] ? resolve(positional[0]) : loadConfig().dbPath
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`)
  process.exit(1)
}
let db: Database
try {
  db = new Database(dbPath, { readonly: true })
  db.query('SELECT 1 FROM exit_vtxos LIMIT 1').get()
} catch {
  db = new Database(dbPath)
}

// Same resolution order the bridge itself uses (config.json > row > defaults),
// so this talks to the ASP the vault was actually built against.
const arkUrl = flag('--url') ?? resolveServerSet(db).arkServerUrl
const only = flag('--outpoint')
const indexer = new RestIndexerProvider(arkUrl)

// Mirrors proof_sync.fetchChain — same page walk, so a difference here is the
// indexer's answer changing, not a different way of asking.
const MAX_PAGES = 50
const PAGE_SIZE = 100
async function fetchChain(txid: string, vout: number): Promise<ChainTx[]> {
  const chain: ChainTx[] = []
  let pageIndex = 0
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await indexer.getVtxoChain({ txid, vout }, { pageIndex, pageSize: PAGE_SIZE })
    chain.push(...res.chain)
    if (!res.page || res.page.next <= res.page.current) break
    pageIndex = res.page.next
  }
  return chain
}

const brief = (t: string): string => `${t.slice(0, 12)}…`
const short = (t: string): string => t.replace('INDEXER_CHAINED_TX_TYPE_', '')
const parentsOf = (c: ChainTx): string[] =>
  (c.spends ?? [])
    .filter((s) => s.trim().length > 0)
    .map((s) => s.split(':')[0]!)
    .filter((t) => t !== c.txid)

console.log(`indexer: ${arkUrl}`)
console.log(`sqlite : ${dbPath}\n`)

let repairable = 0
let upstream = 0

for (const v of listVaultVtxos(db)) {
  const key = `${v.txid}:${v.vout}`
  if (only && only !== key) continue

  const storedIds = new Set(v.chain.map((c) => c.txid))
  const orphans = v.chain.filter(
    (c) => parentsOf(c).length > 0 && !parentsOf(c).some((p) => storedIds.has(p)),
  )
  if (orphans.length === 0) continue

  let live: ChainTx[]
  try {
    live = await fetchChain(v.txid, v.vout)
  } catch (err) {
    console.log(`${brief(v.txid)}:${v.vout}  ✗ indexer refused: ${err instanceof Error ? err.message : err}`)
    continue
  }
  const liveIds = new Set(live.map((c) => c.txid))

  console.log(`${brief(v.txid)}:${v.vout}  ${v.valueSat.toLocaleString()} sats`)
  console.log(`  stored chain ${v.chain.length} entries / live chain ${live.length} entries`)

  for (const o of orphans) {
    const wanted = parentsOf(o)
    const found = wanted.filter((p) => liveIds.has(p))
    console.log(
      `  stored orphan ${short(o.type).padEnd(10)} ${brief(o.txid)} needs ${wanted.map(brief).join(', ')}` +
        ` -> ${found.length > 0 ? 'present in the live chain' : 'absent from the live chain too'}`,
    )
  }

  // THE question, and it is not "is that one parent served". Adding an
  // ancestor moves the boundary: the newly included tx has its own parent,
  // which may be the next thing missing. Only a live chain that CLOSES can
  // repair anything, so ask about the whole chain.
  const liveDangling = danglingEntries(live)
  if (liveDangling.length === 0) {
    repairable++
    console.log(`  live chain is WHOLE -> re-capture repairs this vtxo`)
  } else {
    upstream++
    console.log(`  live chain is ALSO BROKEN (${liveDangling.length} dangling) -> re-capture cannot fix it`)
    for (const d of liveDangling) {
      console.log(`    ${short(d.type).padEnd(10)} ${brief(d.txid)} needs ${parentsOf(d).map(brief).join(', ')}`)
    }
  }

  // A live chain that is larger and a strict superset is the clearest possible
  // statement that the stored one is simply stale.
  const onlyInStored = [...storedIds].filter((t) => !liveIds.has(t))
  const onlyInLive = [...liveIds].filter((t) => !storedIds.has(t))
  console.log(
    `  live adds ${onlyInLive.length} tx(s) the vault lacks; vault holds ${onlyInStored.length} the live chain no longer lists\n`,
  )
}

console.log('='.repeat(70))
console.log(`live chain WHOLE   : ${repairable}  <- re-fetching repairs these`)
console.log(`live chain BROKEN  : ${upstream}  <- the indexer can't produce a closed chain; re-fetching won't help`)
if (upstream > 0) {
  console.log(
    `\nThe indexer's own walk does not close for the outpoint(s) above, so the\n` +
      `bridge re-fetching on every pass changes nothing. Those vtxos are not\n` +
      `unilaterally exitable: move the funds while the ASP still answers (Refresh,\n` +
      `or an onchain send from the Send tab) and report the walk upstream.`,
  )
} else if (repairable > 0) {
  console.log(`\nEvery gap is a stale capture — a restart (or the next sync pass) repairs it.`)
}
