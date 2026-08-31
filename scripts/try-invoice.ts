// Mint one LN invoice through the real receive path and print what happens.
//
// LN receive has two rails and they fail for different reasons, but a phone
// only ever shows its own rendering of the error — Zeus turns any CLINK
// failure into "could not connect to the CLINK relay", and an NWC client
// shows whatever it feels like. This runs the SAME core both rails use
// (ln_receive.issueInvoice) straight from the host and prints the raw error,
// so diagnosing does not need a working phone.
//
//   >= 330 sats -> Boltz reverse swap (boltz locks a VHTLC on Ark)
//   <  330 sats -> atomic sub-dust receive (boltz funds a shared vtxo)
//
// Both make BOLTZ spend its own Ark-side funds, which is the usual reason
// receive breaks while sending stays fine. Sending needs none.
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
import { initBoltz } from '../src/boltz'
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
console.log(`ark   : ${servers.arkServerUrl}`)
console.log(`boltz : ${servers.boltzApiUrl}`)
console.log(`amount: ${sats} sats (${sats < 330 ? 'atomic sub-dust receive' : 'reverse swap'})\n`)

const { wallet } = await initArkWallet({ ...cfg, ...servers }, hexToBytes(row.nsec_hex))
const { swaps } = await initBoltz({ db, wallet, cfg: { ...cfg, ...servers } })

try {
  const issued = await issueInvoice(
    { swaps, wallet, db, boltzApiUrl: servers.boltzApiUrl, arkServerUrl: servers.arkServerUrl },
    { amountSats: sats, description: 'bridge receive probe' },
  )
  console.log(`OK   kind=${issued.kind} swap=${issued.swapId}`)
  console.log(`     lands on Ark: ${issued.receivedSats} sats (fee ${sats - issued.receivedSats})`)
  console.log(`     expires: ${new Date(issued.expiresAt * 1000).toISOString()}`)
  console.log(`\n${issued.invoice}`)
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`)
  // boltz's own words are what actually identify the cause; the SDK wraps them
  // in errorData rather than the message.
  const data = (err as { errorData?: unknown }).errorData
  if (data !== undefined) console.error(`boltz said: ${JSON.stringify(data)}`)
  if (err instanceof Error && err.stack) console.error(`\n${err.stack.split('\n').slice(1, 6).join('\n')}`)
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
