import './polyfills'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { loadAccount } from './account'
import { initArkWallet } from './wallet'
import { initBoltz } from './boltz'
import { startNostrService } from './nostr/service'
import { startWebServer, type AppStateRef } from './web/server'
import { SseHub } from './lib/sse'
import { relayStatusPayload } from './lib/relay_status'

async function main(): Promise<void> {
  const cfg = loadConfig()

  console.log('arkade-nwc-bridge starting')
  console.log(`  network        ${cfg.network}`)
  console.log(`  ark server     ${cfg.arkServerUrl}`)
  console.log(`  nwc relays     ${cfg.nwcRelays.join(', ')}`)
  console.log(`  http           http://${cfg.httpBind}:${cfg.httpPort}`)
  console.log(`  sqlite         ${cfg.dbPath}`)

  const db = openDatabase(cfg.dbPath)
  const migrationCount = db
    .query<{ count: number }, []>('SELECT COUNT(*) as count FROM schema_migrations')
    .get()
  console.log(`  schema         v${migrationCount?.count ?? 0}`)

  const appState: AppStateRef = { current: { mode: 'setup' } }
  const sseHub = new SseHub()

  // Lift the wallet/boltz/nostr bring-up into a function so it can run
  // either at boot (if an account row exists) or post-setup from the web
  // handler (after the user submits /setup). Same path either way; mutates
  // appState in place so the web server's open closures see the new mode.
  const bootReady = async (privateKey: Uint8Array): Promise<void> => {
    const { wallet, address } = await initArkWallet(cfg, privateKey)
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

    const nostr = await startNostrService({
      cfg,
      db,
      wallet,
      swaps,
      onRelayStatusChange: (status) => {
        sseHub.broadcast('relay-status', relayStatusPayload(status))
      },
    })

    appState.current = { mode: 'ready', wallet, swaps, nostr, arkAddress: address }
    console.log('ready — waiting for NWC requests')
  }

  const account = loadAccount(db)
  if (account) {
    await bootReady(account.privateKey)
  } else {
    console.log('  account        none — open /setup to create or import one')
  }

  const web = startWebServer({ cfg, db, state: appState, sseHub, bootReady })
  console.log(`  web ui         ${web.url}`)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down`)
    sseHub.closeAll()
    await web.stop()
    if (appState.current.mode === 'ready') {
      await appState.current.nostr.stop()
      await appState.current.swaps.dispose()
      // Wallet.dispose tears down the VtxoManager poll loop, ContractWatcher's
      // SSE subscription, and ArkProvider's settlement-event stream so the
      // Ark server sees a clean disconnect rather than a half-open socket.
      await appState.current.wallet.dispose()
    }
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
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
