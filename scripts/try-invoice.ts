// Mint one LN invoice through the real receive path and print what happens.
//
// A phone only ever shows its own rendering of a receive error — Zeus turns
// any CLINK failure into "could not connect to the CLINK relay", and an NWC
// client shows whatever it feels like. This runs the SAME core both rails use
// (ln_receive.issueInvoice) straight from the host and prints the raw error,
// so diagnosing does not need a working phone.
//
// Every receive is an atomic receive against subdustd (D10), funded from
// subdustd's own Ark float — the usual reason receive breaks while sending
// stays fine (sending needs no float: subdustd refuses with 503 when it
// cannot fund the amount).
//
// Minting is cheap and reversible: an unpaid BOLT11 just expires, and no
// capital is committed until someone pays it. Nothing is written to the
// bridge's own ledger — this bypasses the NWC/CLINK bookkeeping on purpose.
//
// Usage: bun run try-invoice [sats] [db.sqlite]   (default 1000 sats)
import '../src/polyfills'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { loadConfig } from '../src/config'
import { resolveServerSet } from '../src/server_config'
import { initArkWallet } from '../src/wallet'
import { issueInvoice } from '../src/ln_receive'
import { hexToBytes } from 'nostr-tools/utils'

const argv = process.argv.slice(2)
const sats = Number(argv[0] ?? 1000)
if (!Number.isInteger(sats) || sats <= 0) {
  console.error('usage: bun run try-invoice [sats] [db.sqlite]')
  process.exit(1)
}
const dbPath = argv[1] ? resolve(argv[1]) : loadConfig().dbPath
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`)
  process.exit(1)
}

const db = new Database(dbPath)
const row = db
  .query<{ nsec_hex: string }, []>('SELECT nsec_hex FROM accounts ORDER BY id LIMIT 1')
  .get()
if (!row) {
  console.error('no account row — complete /setup first')
  process.exit(1)
}

const cfg = loadConfig()
const servers = resolveServerSet(db)
if (!cfg.lightning) {
  console.error('no lightning block in data/config.json — this bridge is Ark-only')
  process.exit(1)
}
console.log(`ark      : ${servers.arkServerUrl}`)
console.log(`subdustd : ${cfg.lightning.subdustdUrl}`)
console.log(`amount   : ${sats} sats\n`)

const { wallet } = await initArkWallet({ ...cfg, ...servers }, hexToBytes(row.nsec_hex))

try {
  const issued = await issueInvoice(
    { wallet, db, subdustdUrl: cfg.lightning.subdustdUrl, arkServerUrl: servers.arkServerUrl },
    { amountSats: sats, description: 'bridge receive probe' },
  )
  console.log(`OK   swap=${issued.swapId}`)
  console.log(`     lands on Ark: ${issued.receivedSats} sats`)
  console.log(`     expires: ${new Date(issued.expiresAt * 1000).toISOString()}`)
  console.log(`\n${issued.invoice}`)
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`)
  if (err instanceof Error && err.stack) console.error(`\n${err.stack.split('\n').slice(1, 6).join('\n')}`)
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
