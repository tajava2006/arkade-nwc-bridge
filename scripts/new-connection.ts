import { loadConfig } from '../src/config'
import { openDatabase } from '../src/db'
import { createConnection } from '../src/nostr/connections'

function main(): void {
  const label = process.argv[2] ?? null

  const cfg = loadConfig()
  const db = openDatabase(cfg.dbPath)

  const { connection, uri } = createConnection(db, {
    label,
    relays: cfg.nwcRelays,
  })

  console.log()
  console.log(`connection #${connection.id} created${label ? ` (label: ${label})` : ''}`)
  console.log(`service pubkey: ${connection.servicePubkeyHex}`)
  console.log()
  console.log('NWC URI (paste into your nostr client):')
  console.log()
  console.log(uri)
  console.log()
  console.log('The client secret is embedded in the URI above and is NOT')
  console.log('stored anywhere on this server. Save the URI now or re-issue it.')
}

main()
