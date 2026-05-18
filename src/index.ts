import { loadConfig } from './config'
import { openDatabase } from './db'

function main(): void {
  const cfg = loadConfig()

  console.log('arkade-nwc-bridge starting')
  console.log(`  network        ${cfg.network}`)
  console.log(`  ark server     ${cfg.arkServerUrl}`)
  console.log(`  boltz          ${cfg.boltzUrl}`)
  console.log(`  nwc relays     ${cfg.nwcRelays.join(', ')}`)
  console.log(`  http           http://${cfg.httpBind}:${cfg.httpPort}`)
  console.log(`  sqlite         ${cfg.dbPath}`)
  // ark identity key is loaded but never logged.

  const db = openDatabase(cfg.dbPath)
  const migrationCount = db
    .query<{ count: number }, []>('SELECT COUNT(*) as count FROM schema_migrations')
    .get()
  console.log(`  schema         v${migrationCount?.count ?? 0}`)
}

main()
