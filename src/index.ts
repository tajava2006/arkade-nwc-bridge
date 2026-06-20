import './polyfills'
import { SimplePool } from 'nostr-tools/pool'

import { loadConfig } from './config'
import {
  NWC_RELAYS_FALLBACK,
  OUTBOX_BOOTSTRAP_RELAYS,
  OUTBOX_DISCOVERY_PUBKEY,
  OUTBOX_INITIAL_TIMEOUT_MS,
} from './defaults'
import { openDatabase } from './db'
import { loadAccount } from './account'
import { RestArkProvider } from '@arkade-os/sdk'
import { initArkWallet } from './wallet'
import { initBoltz } from './boltz'
import { startNostrService } from './nostr/service'
import { startOfferService } from './clink/offers'
import { normalizeRelayUrl, startOutboxWatcher } from './nostr/outbox'
import { listActiveConnections } from './nostr/connections'
import { startWebServer, type AppStateRef, type SwrCaches } from './web/server'
import { SseHub } from './lib/sse'
import { AsyncCache } from './lib/cache'
import {
  connectionRelayPayload,
  outboxPanelPayload,
} from './lib/relay_status'
import { renderBalanceFragment } from './web/views/dashboard'
import { renderHistoryFragment } from './web/views/history'

async function main(): Promise<void> {
  const cfg = loadConfig()

  console.log('arkade-nwc-bridge starting')
  console.log(`  network        ${cfg.network}`)
  console.log(`  ark server     ${cfg.arkServerUrl}`)
  console.log(`  boltz          ${cfg.boltzApiUrl}`)
  console.log(`  http           http://${cfg.httpBind}:${cfg.httpPort}`)
  console.log(`  sqlite         ${cfg.dbPath}`)

  const db = openDatabase(cfg.dbPath)
  const migrationCount = db
    .query<{ count: number }, []>('SELECT COUNT(*) as count FROM schema_migrations')
    .get()
  console.log(`  schema         v${migrationCount?.count ?? 0}`)

  const appState: AppStateRef = { current: { mode: 'setup' } }
  const sseHub = new SseHub()

  // Single shared pool for the whole bridge. Outbox watcher uses it for
  // bootstrap subs + outbox-relay ensureRelay; nostr service uses it
  // for per-connection NWC subs. listConnectionStatus from this pool is
  // the single source of truth — the outbox panel and connection rows
  // can't disagree on a relay's state because they're reading the same
  // socket.
  //
  // enableReconnect handles "relay was up, dropped briefly" with an
  // internal backoff. But if a reconnect attempt *also* fails (relay
  // still down), nostr-tools sets skipReconnection=true, permanently
  // closes every subscription on that socket, and drops the relay
  // from the pool entirely — after that, it never tries again until
  // something explicitly ensureRelay's the URL. The watchdog below
  // resurrects the *socket*; re-issuing the REQs on the fresh socket
  // is persistent_sub.ts's job (the watchdog can't — a resurrected
  // AbstractRelay starts with zero subscriptions). enablePing keeps
  // healthy sockets from going stale behind NAT/idle timeouts; in Bun
  // it takes the dummy-REQ fallback (no ws.once), which works fine.
  const pool = new SimplePool({ enableReconnect: true, enablePing: true })

  // Resolve the outbox before the wallet/nostr bring-up so the
  // resolved relay list is available the first time the operator
  // opens /connections/new. Watcher keeps running afterward; later
  // 10002 updates change new-connection defaults but don't touch
  // existing connections.
  const outbox = await startOutboxWatcher({
    pool,
    pubkey: OUTBOX_DISCOVERY_PUBKEY,
    bootstrapRelays: OUTBOX_BOOTSTRAP_RELAYS,
    fallback: NWC_RELAYS_FALLBACK,
    initialTimeoutMs: OUTBOX_INITIAL_TIMEOUT_MS,
  })
  console.log(
    `  outbox         ${outbox.isResolved() ? 'resolved' : 'unresolved (using fallback)'} — ${outbox.getOutboxRelays().length} relays`,
  )

  // Pool-level callbacks are single fields, not events; index.ts is the
  // one place that listens, then fans out to the subsystems' SSE
  // broadcasts. Both up- and down-edge fire the same dispatch. Wired
  // *after* startOutboxWatcher so the closure can safely reference
  // `outbox` — the watcher's own ensureRelay calls during startup fire
  // these callbacks before `outbox` is initialized, and that would TDZ
  // otherwise.
  const broadcastOutboxPanel = (): void => {
    sseHub.broadcast(
      'outbox-update',
      outboxPanelPayload({
        bootstrap: outbox.getBootstrapRelayStatus(),
        outbox: outbox.getOutboxRelayStatus(),
        outboxResolved: outbox.isResolved(),
      }),
    )
  }
  const dispatchRelayChange = (url: string): void => {
    // Outbox/bootstrap panels read the same URL set we just touched —
    // re-render unconditionally rather than figure out membership.
    // Cost is a few KB of HTML, gain is no missed updates.
    broadcastOutboxPanel()
    // Per-connection rows: fan out to every active connection that
    // lists this URL. Off-app connections (revoked, never created)
    // are filtered out by listActiveConnections.
    for (const conn of listActiveConnections(db)) {
      if (!conn.relays.includes(url)) continue
      sseHub.broadcast(
        'connection-update',
        connectionRelayPayload(conn.id, snapshotConnectionRelays(pool, conn.relays)),
      )
    }
  }
  pool.onRelayConnectionSuccess = dispatchRelayChange
  pool.onRelayConnectionFailure = dispatchRelayChange
  outbox.onOutboxChange(() => broadcastOutboxPanel())

  // Watchdog: every few seconds, re-ensureRelay every URL the bridge
  // currently cares about. ensureRelay is a no-op when the socket is
  // already connected, but resurrects relays that the pool gave up on
  // — see the long comment on `new SimplePool` above. Without this, a
  // relay that goes down for longer than the internal backoff
  // permanently stays "offline" in our UI even after it comes back.
  // This loop is socket-level only; subscription recovery on those
  // resurrected sockets is handled by persistent_sub.ts.
  const RELAY_WATCHDOG_INTERVAL_MS = 5000
  const knownRelayUrls = (): Set<string> => {
    const urls = new Set<string>()
    for (const url of OUTBOX_BOOTSTRAP_RELAYS) urls.add(normalizeRelayUrl(url))
    for (const url of outbox.getOutboxRelays()) urls.add(url)
    for (const conn of listActiveConnections(db)) {
      for (const url of conn.relays) urls.add(url)
    }
    return urls
  }
  const watchdog = setInterval(() => {
    for (const url of knownRelayUrls()) {
      pool.ensureRelay(url).catch(() => {
        // ensureRelay rejects on connect failure. The pool also fires
        // onRelayConnectionFailure separately, which is the path our
        // UI updates flow through — nothing for us to do here.
      })
    }
  }, RELAY_WATCHDOG_INTERVAL_MS)

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

    const { swaps } = await initBoltz({ db, wallet, cfg })
    const fees = await swaps.getFees()
    console.log(
      `  boltz fees     submarine=${fees.submarine.percentage}% reverse=${fees.reverse.percentage}%`,
    )

    const nostr = await startNostrService({ cfg, db, wallet, swaps, pool })

    // CLINK Offers: serve the static noffer receive code under the account
    // key (same key as the Ark wallet). Minted from the current outbox relay
    // and persisted; on boot it listens on the relay frozen into the stored
    // code (see clink/offers.ts). Operator regenerates by hand if it dies.
    const offers = startOfferService({ pool, db, secretKey: privateKey, outbox, swaps })
    console.log(`  noffer         ${offers.snapshot().noffer}`)

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

    // Second provider for /send's ArkInfo reads (dust + intent-fee programs).
    // Stateless REST; the wallet keeps its own internal one for signing.
    const arkProvider = new RestArkProvider(cfg.arkServerUrl)

    appState.current = {
      mode: 'ready',
      wallet,
      swaps,
      nostr,
      offers,
      caches,
      arkAddress: address,
      arkProvider,
    }
    console.log('ready — waiting for NWC requests')
  }

  const account = loadAccount(db)
  if (account) {
    await bootReady(account.privateKey)
  } else {
    console.log('  account        none — open /setup to create or import one')
  }

  const web = startWebServer({ cfg, db, state: appState, sseHub, outbox, bootReady })
  console.log(`  web ui         ${web.url}`)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down`)
    clearInterval(watchdog)
    sseHub.closeAll()
    await web.stop()
    if (appState.current.mode === 'ready') {
      appState.current.offers.stop()
      await appState.current.nostr.stop()
      await appState.current.swaps.dispose()
      // Wallet.dispose tears down the VtxoManager poll loop, ContractWatcher's
      // SSE subscription, and ArkProvider's settlement-event stream so the
      // Ark server sees a clean disconnect rather than a half-open socket.
      await appState.current.wallet.dispose()
    }
    await outbox.stop()
    // Close every relay the shared pool ever touched, in one shot.
    pool.close([...pool.listConnectionStatus().keys()])
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

function snapshotConnectionRelays(
  pool: SimplePool,
  urls: readonly string[],
): { url: string; connected: boolean }[] {
  const live = pool.listConnectionStatus()
  return urls.map((url) => ({ url, connected: live.get(url) === true }))
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
