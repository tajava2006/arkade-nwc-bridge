// Print the bridge's nostr identity from the sqlite file.
//
// The web UI shows the nsec exactly once, during setup — a browser is
// the least trusted surface on this machine, so no route serves the key
// after that. This script is the recovery path: it reads the hex secret
// straight from the `accounts` table and re-encodes it as nsec/npub.
//
// `bun run show-nsec` reads the same sqlite the bridge itself would use
// (repo data/, or the config.json dbPath override). To point it at some
// other sqlite — e.g. a docker volume dir on the host — pass the file as
// an argument, as an absolute path: `bun run` cds to the repo root before
// this script sees a relative one.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { nip19 } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
import { loadConfig } from '../src/config'

const dbPath = process.argv[2] ? resolve(process.argv[2]) : loadConfig().dbPath
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath} — has the bridge completed /setup?`)
  process.exit(1)
}

// Read-only first (never touch a live db); a WAL-mode file copied without
// its -shm/-wal sidecars can't be opened read-only (SQLITE_CANTOPEN — a
// readonly connection may not create the shm), so backups fall back to a
// normal open, which recreates the sidecars and writes nothing else.
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
console.log(`npub: ${nip19.npubEncode(getPublicKey(privateKey))}`)
console.log(`nsec: ${nip19.nsecEncode(privateKey)}`)
console.log()
console.log('Anyone with the nsec controls every sat in this wallet — and it')
console.log('doubles as a full nostr identity. Back it up offline, or import it')
console.log('into a phone nostr signer (Amber on Android, Clave on iOS) so the')
console.log('same identity is usable across nostr apps.')
