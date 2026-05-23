import './polyfills'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { loadAccount } from './account'
import { initArkWallet } from './wallet'
import { initBoltz } from './boltz'
import { startNostrService } from './nostr/service'
import { startWebServer, type AppStateRef, type SwrCaches } from './web/server'
import { SseHub } from './lib/sse'
import { AsyncCache } from './lib/cache'
import { relayStatusPayload } from './lib/relay_status'
import { renderBalanceFragment } from './web/views/dashboard'
import { renderHistoryFragment } from './web/views/history'

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

    // SWR caches for the slow ark-side reads. minIntervalMs keeps
    // back-to-back page visits from hammering the upstream — opening
    // dashboard, history, dashboard within a few seconds only refetches
    // once each. Listeners fan out fresh values over SSE so any open
    // browser tab updates in place.
    const caches: SwrCaches = {
      balance: new AsyncCache({
        label: 'balance',
        fetcher: () => wallet.getBalance(),
        minIntervalMs: 2000,
      }),
      history: new AsyncCache({
        label: 'history',
        fetcher: () => wallet.getTransactionHistory(),
        minIntervalMs: 2000,
      }),
    }
    caches.balance.onUpdate(({ value }) => {
      sseHub.broadcast('balance-status', { html: renderBalanceFragment(value).value })
    })
    caches.history.onUpdate(({ value }) => {
      sseHub.broadcast('history-status', { html: renderHistoryFragment(value).value })
    })
    // Seed the balance cache with the snapshot we already fetched above
    // so the first dashboard visit doesn't pay the round-trip again.
    // Skipping equivalent seeding for history — that read is the slow
    // one and there's no boot-time consumer that already has the data.
    caches.balance.seed(balance)

    appState.current = { mode: 'ready', wallet, swaps, nostr, caches, arkAddress: address }
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
