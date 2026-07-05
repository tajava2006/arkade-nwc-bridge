import './polyfills'
import { SimplePool } from 'nostr-tools/pool'

import { loadConfig } from './config'
import {
  NWC_RELAYS_FALLBACK,
  OUTBOX_BOOTSTRAP_RELAYS,
  OUTBOX_FALLBACK_PUBKEY,
  OUTBOX_INITIAL_TIMEOUT_MS,
} from './defaults'
import { getPublicKey } from 'nostr-tools/pure'
import { openDatabase } from './db'
import { loadAccount } from './account'
import { EsploraProvider, OnchainWallet, RestArkProvider, SingleKey } from '@arkade-os/sdk'
import { initArkWallet } from './wallet'
import { initBoltz } from './boltz'
import { startProofSync, type ProofSyncService } from './exit/sync_service'
import { startExitEngine, type ExitEngine } from './exit/engine'
import { startNostrService } from './nostr/service'
import { startOfferService, sendOfferReceipt, reconcileClinkAcks } from './clink/offers'
import { normalizeRelayUrl, startOutboxWatcher } from './nostr/outbox'
import { listActiveConnections, prunePersistedEvents } from './nostr/connections'
import { startWebServer, type AppStateRef, type SwrCaches } from './web/server'
import { SseHub } from './lib/sse'
import { AsyncCache } from './lib/cache'
import {
  connectionRelayPayload,
  outboxPanelPayload,
} from './lib/relay_status'
import { renderBalanceFragment, renderExitReadinessFragment } from './web/views/dashboard'
import { renderHistoryFragment } from './web/views/history'
import { renderBreakdownFragment } from './web/views/send'

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
    fallbackPubkey: OUTBOX_FALLBACK_PUBKEY,
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
        outboxSource: outbox.getOutboxSource(),
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

  // CLINK ack reconciler interval — assigned once bootReady runs (needs the
  // account key + swaps). Cleared on shutdown.
  let ackReconcilerInterval: ReturnType<typeof setInterval> | undefined

  // Exit-proof mirroring — assigned in bootReady, torn down on shutdown.
  let proofSync: ProofSyncService | undefined
  let stopIncomingFunds: (() => void) | undefined

  // Degraded-mode boot retry — armed by bootReadyOrDegrade, cleared on shutdown.
  let bootRetryTimer: ReturnType<typeof setTimeout> | undefined

  // Unilateral-exit engine — created once on the first boot attempt (ready
  // OR degraded: it only needs sqlite + the nsec + esplora, never the ASP)
  // and reused across mode flips. resume() re-drives ops interrupted by the
  // restart.
  let exitEngine: ExitEngine | undefined
  const ensureExitEngine = (privateKey: Uint8Array): ExitEngine => {
    if (!exitEngine) {
      exitEngine = startExitEngine({
        db,
        identity: SingleKey.fromPrivateKey(privateKey),
        network: cfg.network,
        esploraUrls: cfg.esploraUrls,
        log: (msg) => console.log(msg),
      })
      exitEngine.resume()
    }
    return exitEngine
  }

  // Bound the processed_events replay-backstop table: rows past the redelivery
  // window can't be replayed, so drop anything older than the TTL. Runs at boot
  // (clears pre-existing bloat) + periodically. Only needs `db`, so it lives out
  // here rather than in bootReady.
  const PROCESSED_EVENT_TTL_SEC = 3600
  prunePersistedEvents(db, PROCESSED_EVENT_TTL_SEC)
  const eventPrune = setInterval(
    () => {
      const n = prunePersistedEvents(db, PROCESSED_EVENT_TTL_SEC)
      if (n > 0) console.log(`pruned ${n} processed_events row(s)`)
    },
    10 * 60 * 1000,
  )

  // Lift the wallet/boltz/nostr bring-up into a function so it can run
  // either at boot (if an account row exists) or post-setup from the web
  // handler (after the user submits /setup). Same path either way; mutates
  // appState in place so the web server's open closures see the new mode.
  const bootReady = async (privateKey: Uint8Array): Promise<void> => {
    // The account key is the bridge's own nostr identity (noffer pubkey,
    // NWC service pubkey). Make it the primary outbox target so relay
    // discovery follows the same key everything else is published under;
    // until it has its own 10002, the watcher stays on the operator's.
    // Idempotent for the same key, so safe on both boot paths.
    outbox.setPrimaryPubkey(getPublicKey(privateKey))

    ensureExitEngine(privateKey)

    // Unwind stack for a partially-built bring-up. bootReady used to be
    // crash-on-failure (process exit), so a half-created wallet could never
    // leak; with the degraded-mode retry loop below, every failed attempt
    // that got past initArkWallet would otherwise stack another VtxoManager
    // poll + SSE watcher per minute.
    const undo: Array<() => Promise<unknown> | unknown> = []
    try {

      const { wallet, address } = await initArkWallet(cfg, privateKey)
      console.log(`  ark address    ${address}`)
      undo.push(() => wallet.dispose())

      const balance = await wallet.getBalance()
      console.log(
        `  balance        total=${balance.total} available=${balance.available} settled=${balance.settled} boarding=${balance.boarding.total}`,
      )

      const { swaps } = await initBoltz({
        db,
        wallet,
        cfg,
        // When an offer-originated reverse swap settles, ack the payer with a
        // CLINK Payment Receipt. No-op for NWC make_invoice swaps.
        onReverseSettled: (swap) => {
          sendOfferReceipt({ pool, db, secretKey: privateKey }, swap).catch((err) =>
            console.error('clink: receipt send failed:', err),
          )
        },
      })
      undo.push(() => swaps.dispose())
      const fees = await swaps.getFees()
      console.log(
        `  boltz fees     submarine=${fees.submarine.percentage}% reverse=${fees.reverse.percentage}%`,
      )

      const nostr = await startNostrService({ cfg, db, wallet, swaps, pool })
      undo.push(() => nostr.stop())

      // CLINK Offers: serve the static noffer receive code under the account
      // key (same key as the Ark wallet). Minted from the current outbox relay
      // and persisted; on boot it listens on the relay frozen into the stored
      // code (see clink/offers.ts). Operator regenerates by hand if it dies.
      const offers = startOfferService({ pool, db, secretKey: privateKey, outbox, swaps, wallet, boltzApiUrl: cfg.boltzApiUrl })
      console.log(`  noffer         ${offers.snapshot().noffer}`)
      undo.push(() => offers.stop())

      // Restart-safe CLINK acks: catch up on receipts the live onReverseSettled
      // missed (swaps that settled while we were down) + drive sub-dust acks.
      const ackDeps = { pool, db, secretKey: privateKey, boltzApiUrl: cfg.boltzApiUrl }
      void reconcileClinkAcks(ackDeps).catch((err) => console.error('clink: ack reconcile (boot) failed:', err))
      ackReconcilerInterval = setInterval(() => {
        void reconcileClinkAcks(ackDeps).catch((err) => console.error('clink: ack reconcile failed:', err))
      }, 30_000)

      // Second provider for /send's ArkInfo reads (dust + intent-fee programs).
      // Stateless REST; the wallet keeps its own internal one for signing.
      const arkProvider = new RestArkProvider(cfg.arkServerUrl)

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
        // /send's breakdown needs ArkInfo (dust + fee programs), the full VTXO
        // set and the boltz fee table (LN drain hint) together — fetched in
        // parallel so the page renders from a snapshot instead of blocking on
        // sequential round-trips. The set churns, but we push the whole table
        // fragment over SSE (no diffing).
        sendData: new AsyncCache({
          label: 'send-data',
          fetcher: async () => {
            const [arkInfo, vtxos, fees] = await Promise.all([
              arkProvider.getInfo(),
              wallet.getVtxos({ withRecoverable: true }),
              swaps.getFees(),
            ])
            return { arkInfo, vtxos, fees }
          },
          minIntervalMs: 2000,
        }),
      }
      caches.balance.onUpdate(({ value }) => {
        sseHub.broadcast('balance-status', { html: renderBalanceFragment(value).value })
      })
      caches.history.onUpdate(({ value }) => {
        sseHub.broadcast('history-status', { html: renderHistoryFragment(value).value })
      })
      caches.sendData.onUpdate(({ value }) => {
        sseHub.broadcast('send-breakdown', { html: renderBreakdownFragment(value).value })
      })
      // Seed the balance cache with the snapshot we already fetched above
      // so the first dashboard visit doesn't pay the round-trip again.
      // Skipping equivalent seeding for history — that read is the slow
      // one and there's no boot-time consumer that already has the data.
      caches.balance.seed(balance)

      // Exit-proof mirroring (EXIT_PLAN #04/#05): keep the vault able to
      // unilaterally exit every live vtxo after the ASP dies. Triggers: a
      // boot reconcile now, the wallet's funds subscription (fires for
      // incoming AND outgoing activity), and the service's own slow poll as
      // the missed-event safety net. Gap/failure retry lives in the service.
      const proofSyncSvc = startProofSync({
        db,
        indexer: wallet.indexerProvider,
        listVtxos: () => wallet.getVtxos({ withRecoverable: true }),
        log: (msg) => console.log(msg),
      })
      proofSync = proofSyncSvc
      proofSyncSvc.onUpdate((snap) => {
        sseHub.broadcast('exit-readiness', { html: renderExitReadinessFragment(snap).value })
      })
      proofSyncSvc.trigger('boot')
      try {
        stopIncomingFunds = await wallet.notifyIncomingFunds(() =>
          proofSyncSvc.trigger('funds-activity'),
        )
      } catch (err) {
        // best-effort: the reconcile poll still converges without the push
        console.warn(
          `exit-sync: funds subscription failed (poll still covers): ${err instanceof Error ? err.message : err}`,
        )
      }

      // Boarding receive handle (deterministic for our SingleKey). Plus a boot
      // prefetch of ArkInfo + VTXOs: seeds the /send breakdown cache (so the
      // first /send visit is instant) and gives the dashboard the onboarding
      // intent-fee program. Best-effort — on failure both lazy-load on first use.
      const boardingAddress = await wallet.getBoardingAddress()
      let onboardingFeeProgram: string | undefined
      try {
        const [arkInfo, vtxos] = await Promise.all([
          arkProvider.getInfo(),
          wallet.getVtxos({ withRecoverable: true }),
        ])
        // CEL program for the onchain-input intent fee (onboarding); flat
        // configs look like "1000.0", rendered best-effort on the dashboard.
        onboardingFeeProgram = arkInfo.fees?.intentFee?.onchainInput
        // `fees` reuses the boot-time getFees read from above.
        caches.sendData.seed({ arkInfo, vtxos, fees })
      } catch (err) {
        console.warn(
          `boot: send-data prefetch failed (onboarding fee + /send breakdown lazy-load): ${err instanceof Error ? err.message : err}`,
        )
      }

      appState.current = {
        mode: 'ready',
        wallet,
        swaps,
        nostr,
        offers,
        caches,
        pool,
        arkAddress: address,
        boardingAddress,
        onboardingFeeProgram,
        arkProvider,
        proofSync: proofSyncSvc,
      }
      console.log('ready — waiting for NWC requests')
    } catch (err) {
      proofSync?.stop()
      proofSync = undefined
      stopIncomingFunds?.()
      stopIncomingFunds = undefined
      if (ackReconcilerInterval) {
        clearInterval(ackReconcilerInterval)
        ackReconcilerInterval = undefined
      }
      for (const step of undo.reverse()) {
        try {
          await step()
        } catch {
          // best-effort unwind — the retry loop is about to rebuild anyway
        }
      }
      throw err
    }
  }

  // Boot-path wrapper (EXIT_PLAN #07): the ASP or Boltz being down must not
  // keep the bridge from starting — that is exactly when the operator needs
  // the exit tab. Any bootReady failure lands in mode:'degraded' (vault +
  // esplora + nsec-derived onchain wallet still work, no ASP required) and
  // a 60s loop keeps re-attempting the full bring-up; success promotes to
  // ready in place and tells open tabs to reload. Whole-or-nothing on
  // purpose: partial-ready (e.g. wallet up, boltz down) would fork the
  // AppState into per-subsystem availability flags for a rare, transient
  // state the retry loop already heals.
  const BOOT_RETRY_MS = 60_000
  let bootAttempts = 0
  const bootReadyOrDegrade = async (privateKey: Uint8Array): Promise<void> => {
    try {
      await bootReady(privateKey)
      if (bootAttempts > 0) {
        console.log(`boot: recovered after ${bootAttempts} failed attempt(s) — ready`)
        sseHub.broadcast('mode-change', { mode: 'ready' })
      }
      bootAttempts = 0
    } catch (err) {
      bootAttempts++
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `boot: degraded — ${msg} (attempt ${bootAttempts}, retrying in ${BOOT_RETRY_MS / 1000}s)`,
      )
      if (appState.current.mode !== 'degraded') {
        // No network here: OnchainWallet.create only derives the P2TR from
        // the nsec key; the provider stays lazy until something reads it.
        const identity = SingleKey.fromPrivateKey(privateKey)
        const onchain = await OnchainWallet.create(
          identity,
          cfg.network,
          new EsploraProvider(cfg.esploraUrls[0]),
        )
        appState.current = {
          mode: 'degraded',
          error: msg,
          since: Math.floor(Date.now() / 1000),
          attempts: bootAttempts,
          onchainAddress: onchain.address,
        }
        sseHub.broadcast('mode-change', { mode: 'degraded' })
      } else {
        appState.current = { ...appState.current, error: msg, attempts: bootAttempts }
      }
      bootRetryTimer = setTimeout(() => void bootReadyOrDegrade(privateKey), BOOT_RETRY_MS)
    }
  }

  const account = loadAccount(db)
  if (account) {
    await bootReadyOrDegrade(account.privateKey)
  } else {
    console.log('  account        none — open /setup to create or import one')
  }

  const web = startWebServer({ cfg, db, state: appState, sseHub, outbox, bootReady })
  console.log(`  web ui         ${web.url}`)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down`)
    clearInterval(watchdog)
    clearInterval(eventPrune)
    if (ackReconcilerInterval) clearInterval(ackReconcilerInterval)
    proofSync?.stop()
    stopIncomingFunds?.()
    if (bootRetryTimer) clearTimeout(bootRetryTimer)
    exitEngine?.stop()
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
