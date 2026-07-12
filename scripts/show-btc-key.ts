// Print the bridge's key as a Bitcoin private key (WIF + tr() descriptor).
//
// This is escape hatch #1 for the post-exit funds: everything the exit
// engine sweeps lands on the P2TR address derived from the same secp256k1
// key that is the nostr identity (ts-sdk OnchainWallet: p2tr(xonly), no
// script tree — exactly Bitcoin Core's tr(KEY) derivation). Import the
// descriptor into any descriptor wallet, rescan, and the funds appear;
// no bridge software needed ever again.
//
// Same sqlite conventions as show-nsec.ts: reads the db the bridge itself
// would use, or a copy passed as an absolute path argument.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { schnorr } from '@noble/curves/secp256k1.js'
import { WIF, p2tr } from '@scure/btc-signer'
import { getNetwork } from '@arkade-os/sdk'
import { hexToBytes } from 'nostr-tools/utils'
import { loadConfig } from '../src/config'
import { NETWORK } from '../src/defaults'
import { withChecksum } from '../src/lib/descriptor'

const dbPath = process.argv[2] ? resolve(process.argv[2]) : loadConfig().dbPath
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath} — has the bridge completed /setup?`)
  process.exit(1)
}

// Read-only first (never touch a live db); fall back for WAL copies missing
// their sidecars — same dance as show-nsec.ts.
let db: Database
try {
  db = new Database(dbPath, { readonly: true })
  db.query('SELECT 1 FROM accounts LIMIT 1').get()
} catch {
  db = new Database(dbPath)
}
const row = db
  .query<{ nsec_hex: string }, []>('SELECT nsec_hex FROM accounts ORDER BY id LIMIT 1')
  .get()
if (!row) {
  console.error(`${dbPath} exists but has no account row — complete /setup first`)
  process.exit(1)
}

const privateKey = hexToBytes(row.nsec_hex)
const network = getNetwork(NETWORK)
const xonly = schnorr.getPublicKey(privateKey)
const address = p2tr(xonly, undefined, network).address
const wif = WIF(network).encode(privateKey)

console.log(`address:    ${address}`)
console.log(`WIF:        ${wif}`)
console.log(`descriptor: ${withChecksum(`tr(${wif})`)}`)
console.log()
console.log('Import into a normal Bitcoin wallet:')
console.log('- Sparrow: File → New Wallet → paste the descriptor (Edit → Descriptor).')
console.log('- Bitcoin Core: importdescriptors with the descriptor above and')
console.log('  "timestamp": <unix time before your first exit sweep> — a rescan')
console.log('  runs automatically; funds appear when it finishes.')
console.log('- Wallets without taproot descriptor support (e.g. Electrum) will')
console.log('  not find these coins; pick one that has it.')
console.log()
console.log('This is the SAME key as the nsec: whatever wallet you import it')
console.log('into now also holds your nostr identity. Treat that machine')
console.log('accordingly, and prefer sweeping onward to a fresh cold wallet.')
