// Audit the exit vault's stored chains for missing ancestry.
//
// WHY: /exit/<vtxo> lays the pre-signed chain out as a DAG whose top level is
// supposed to be commitments only. A CHECKPOINT showing up there means its
// `spends` resolved to nothing inside its own chain array — chain_order.ts
// drops an edge whose target isn't in the array, so the node lands at depth 0
// next to the commitments and its children get pushed below it. The layout is
// faithful; the input is short.
//
// That matters beyond cosmetics: `proofComplete` (estimate.ts) and
// `missingProofTxids` are both computed RELATIVE TO THE STORED CHAIN, and
// proof_sync never re-fetches a chain once it has one ("ancestry is
// immutable"). So a chain captured with a hole reports itself complete
// forever, while an unroll would run out of packages partway. arkd can hand
// back such a chain without erroring: walkVtxoChain only fails when EVERY
// parent in a wave is unresolvable, and silently drops the rest
// (indexer.go, `vtxo not found for outpoint`).
//
// This script does NOT decide that on its own — it classifies each orphan so
// the two cases can be told apart:
//
//   [A] the parent txid is absent from the chain      -> exit material is
//       missing; the vault's proof-complete claim is a lie for that vtxo
//   [B] the parent IS present, the edge just failed   -> parsing/display only
//   [C] `spends` came back empty                      -> upstream never set it
//
// Read-only. `bun run check-exit-chains` uses the same sqlite the bridge
// would; pass an ABSOLUTE path to point it elsewhere (e.g. the docker host
// dir, my-server/bridge-data/bridge.sqlite) — `bun run` cds to the repo root
// before this script sees a relative one.
// Must come first: the SDK's descriptor code CJS-requires async-ESM modules,
// which Bun rejects unless they were ESM-imported earlier in the process.
import '../src/polyfills'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { ChainTxType, type ChainTx } from '@arkade-os/sdk'
import { loadConfig } from '../src/config'
import { listVaultVtxos, missingProofTxids, proofTxidsOf } from '../src/exit/vault'
import { chainGraph } from '../src/exit/chain_order'

const dbPath = process.argv[2] ? resolve(process.argv[2]) : loadConfig().dbPath
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`)
  process.exit(1)
}

// Same read-only-first dance as show-nsec: a WAL file copied without its
// -shm/-wal sidecars can't be opened read-only, so fall back to a normal open
// (which recreates the sidecars and writes nothing else).
let db: Database
try {
  db = new Database(dbPath, { readonly: true })
  db.query('SELECT 1 FROM exit_vtxos LIMIT 1').get()
} catch {
  db = new Database(dbPath)
}

const ROOTISH: readonly string[] = [ChainTxType.COMMITMENT, ChainTxType.UNSPECIFIED]
const short = (t: string): string => t.replace('INDEXER_CHAINED_TX_TYPE_', '')
const brief = (txid: string): string => `${txid.slice(0, 12)}…`
/** byte-reversed txid — catches a display-vs-internal ordering mismatch */
const reversed = (txid: string): string => (txid.match(/../g) ?? []).reverse().join('')

type Verdict = 'A' | 'B' | 'C'
interface Orphan {
  tx: ChainTx
  verdict: Verdict
  hasPsbt: boolean
}

function orphansOf(chain: ChainTx[], storedProofs: Set<string>): Orphan[] {
  const ids = new Set(chain.map((c) => c.txid))
  const out: Orphan[] = []
  for (const c of chain) {
    if (ROOTISH.includes(c.type)) continue // commitments are roots by design
    // Blank entries count as "nothing named", not as an unresolvable parent —
    // otherwise an upstream that serves empty strings reads as data loss.
    const raw = (c.spends ?? []).filter((s) => s.trim().length > 0)
    // chain_order.ts's rule: checkpoints name their parent as "txid:vout",
    // everything else as a bare txid.
    const stripped = raw.map((s) => s.split(':')[0]!).filter((t) => t !== c.txid)
    if (stripped.some((t) => ids.has(t))) continue // has a real parent

    const verdict: Verdict =
      raw.length === 0
        ? 'C'
        : raw.some((s) => ids.has(s)) || stripped.some((t) => ids.has(reversed(t)))
          ? 'B'
          : 'A'
    out.push({ tx: c, verdict, hasPsbt: storedProofs.has(c.txid) })
  }
  return out
}

const vtxos = listVaultVtxos(db)
const storedProofs = new Set(
  db.query<{ txid: string }, []>('SELECT txid FROM exit_proof_txs').all().map((r) => r.txid),
)

const totals: Record<Verdict, number> = { A: 0, B: 0, C: 0 }
let affected = 0
let proofGaps = 0

for (const v of vtxos) {
  const orphans = orphansOf(v.chain, storedProofs)
  const missingProofs = missingProofTxids(db, v.chain)
  if (missingProofs.length > 0) proofGaps++
  if (orphans.length === 0 && missingProofs.length === 0) continue
  if (orphans.length > 0) affected++

  const unique = new Set(v.chain.map((c) => c.txid)).size
  const dupes = v.chain.length - unique
  const commitments = v.chain.filter((c) => ROOTISH.includes(c.type)).length
  console.log(
    `\n${brief(v.txid)}:${v.vout}  ${v.valueSat.toLocaleString()} sats  source=${v.source}\n` +
      `  chain=${v.chain.length} (unique ${unique}${dupes ? `, ${dupes} duplicated by arkd's BFS` : ''}), ` +
      `commitments=${commitments}, proofs stored=${proofTxidsOf(v.chain).length - missingProofs.length}` +
      `/${proofTxidsOf(v.chain).length}`,
  )

  // What the /exit page actually draws on its top row — this is the line to
  // compare against the screen.
  try {
    const top = chainGraph(v.chain).levels[0] ?? []
    console.log(`  rendered top level: ${top.map((c) => `${brief(c.txid)}(${short(c.type)})`).join(', ')}`)
  } catch (err) {
    console.log(`  rendered top level: <chainGraph threw: ${err instanceof Error ? err.message : err}>`)
  }

  for (const o of orphans) {
    totals[o.verdict]++
    console.log(
      `    [${o.verdict}] ${short(o.tx.type).padEnd(10)} ${brief(o.tx.txid)}` +
        `  spends=${JSON.stringify(o.tx.spends ?? [])}` +
        (o.hasPsbt ? '' : '  ⚠ no stored PSBT either'),
    )
  }
  if (missingProofs.length > 0) {
    console.log(`    ⚠ ${missingProofs.length} chain tx(s) have no stored PSBT: ${missingProofs.map(brief).join(', ')}`)
  }
}

console.log(`\n${'='.repeat(70)}`)
console.log(`vault vtxos: ${vtxos.length}`)
console.log(`  with orphaned ancestry : ${affected}`)
console.log(`  with missing PSBTs     : ${proofGaps}`)
console.log(`orphans by verdict:`)
console.log(`  [A] parent absent from the chain : ${totals.A}   <- exit material missing (serious)`)
console.log(`  [B] parent present, edge failed  : ${totals.B}   <- display/parsing only`)
console.log(`  [C] spends came back empty       : ${totals.C}   <- upstream never populated it`)

if (totals.A > 0) {
  console.log(
    `\nAt least one chain is missing an ancestor it needs. Those vtxos cannot be\n` +
      `unrolled from the vault alone, and proof-complete does NOT catch it (it only\n` +
      `checks PSBTs for txs the chain already lists). Re-capture is not automatic:\n` +
      `proof_sync reuses a stored chain forever. Report the outpoints above.`,
  )
} else if (totals.B + totals.C > 0) {
  console.log(`\nNo missing ancestors — the anomaly is display-side only.`)
} else if (affected === 0 && proofGaps === 0) {
  console.log(`\nEvery stored chain is fully connected and fully proofed. Not reproduced here.`)
}
