import './polyfills'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { initArkWallet } from './wallet'
import { initBoltz } from './boltz'
import { startNostrService } from './nostr/service'
import { startWebServer } from './web/server'

async function main(): Promise<void> {
  const cfg = loadConfig()

  console.log('arkade-nwc-bridge starting')
  console.log(`  network        ${cfg.network}`)
  console.log(`  ark server     ${cfg.arkServerUrl}`)
  console.log(`  nwc relays     ${cfg.nwcRelays.join(', ')}`)
  console.log(`  http           http://${cfg.httpBind}:${cfg.httpPort}`)
  console.log(`  sqlite         ${cfg.dbPath}`)
  // ark identity key is loaded but never logged.

  const db = openDatabase(cfg.dbPath)
  const migrationCount = db
    .query<{ count: number }, []>('SELECT COUNT(*) as count FROM schema_migrations')
    .get()
  console.log(`  schema         v${migrationCount?.count ?? 0}`)

  const { wallet, address } = await initArkWallet(cfg)
  console.log(`  ark address    ${address}`)

  const balance = await wallet.getBalance()
  console.log(
    `  balance        total=${balance.total} available=${balance.available} settled=${balance.settled} boarding=${balance.boarding.total}`,
  )

  const { swaps } = await initBoltz({ db, wallet })
  const fees = await swaps.getFees()
  console.log(
    `  boltz fees     submarine=${fees.submarine.percentage}% reverse=${fees.reverse.percentage}%`,
  )

  const nostr = await startNostrService({ cfg, db, wallet, swaps })

  const web = startWebServer({ cfg, db, wallet, arkAddress: address })
  console.log(`  web ui         ${web.url}`)

  // Minimal graceful shutdown so SIGINT/SIGTERM don't leave open sockets
  // straggling. Full ark-wallet / boltz-swap teardown comes in phase 10.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down`)
    await web.stop()
    await nostr.stop()
    await swaps.dispose()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      console.error('shutdown error:', err)
      process.exit(1)
    })
  })
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      console.error('shutdown error:', err)
      process.exit(1)
    })
  })

  console.log('ready — waiting for NWC requests')
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
