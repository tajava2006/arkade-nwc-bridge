// Print the bridge's nostr identity from the sqlite file.
//
// The web UI shows the nsec exactly once, during setup — a browser is
// the least trusted surface on this machine, so no route serves the key
// after that. This script is the recovery path: it reads the hex secret
// straight from the `accounts` table and re-encodes it as nsec/npub.
// Run it from the bridge directory: `bun run show-nsec`.
import { existsSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { nip19 } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
import { loadConfig } from '../src/config'

const { dbPath } = loadConfig()
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath} — has the bridge completed /setup?`)
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })
const row = db
  .query<{ nsec_hex: string }, []>('SELECT nsec_hex FROM accounts ORDER BY id LIMIT 1')
  .get()
if (!row) {
  console.error(`${dbPath} exists but has no account row — complete /setup first`)
  process.exit(1)
}

const privateKey = hexToBytes(row.nsec_hex)
console.log(`npub: ${nip19.npubEncode(getPublicKey(privateKey))}`)
console.log(`nsec: ${nip19.nsecEncode(privateKey)}`)
console.log()
console.log('Anyone with the nsec controls every sat in this wallet — and it')
console.log('doubles as a full nostr identity. Back it up offline, or import it')
console.log('into a phone nostr signer (Amber on Android, Clave on iOS) so the')
console.log('same identity is usable across nostr apps.')
