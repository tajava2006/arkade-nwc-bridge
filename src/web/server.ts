import type { Database } from 'bun:sqlite'
import type { Wallet } from '@arkade-os/sdk'
import type { ArkadeSwaps } from '@arkade-os/boltz-swap'

import type { Config } from '../config'
import { createAccount, generatePrivateKey, parseNsecInput } from '../account'
import { nip19 } from 'nostr-tools'
import { htmlResponse } from '../lib/html'
import {
  createConnection,
  findConnectionById,
  listAllConnections,
  revokeConnection,
} from '../nostr/connections'
import type { NostrService } from '../nostr/service'
import type { SseHub } from '../lib/sse'
import { relayStatusPayload } from '../lib/relay_status'
import type { TransactionRow } from '../lib/transaction'
import { dashboardView } from './views/dashboard'
import { connectionsListView } from './views/connections'
import { newConnectionForm, newConnectionResultView } from './views/new_connection'
import { walletHistoryView } from './views/history'
import { connectionDetailView } from './views/connection_detail'
import { setupGeneratedView, setupView } from './views/setup'
import { qrSvg } from './qr'

export type AppState =
  | { mode: 'setup' }
  | {
      mode: 'ready'
      wallet: Wallet
      swaps: ArkadeSwaps
      nostr: NostrService
      arkAddress: string
    }

/**
 * Shared mutable handle. `current` flips from 'setup' to 'ready' the moment
 * `bootReady` returns from a successful POST /setup, and stays 'ready' for
 * the rest of the process lifetime. Pass it to the web server so handlers
 * read the latest mode on every request without rewiring routes.
 */
export interface AppStateRef {
  current: AppState
}

export interface WebServerDeps {
  cfg: Config
  db: Database
  state: AppStateRef
  sseHub: SseHub
  /**
   * Brings up wallet → boltz → nostr inside the same process. Called from
   * POST /setup after the account row is written. Throws if wiring up the
   * Ark/Boltz/relay clients fails — caller is responsible for cleaning up
   * the partial state (POST /setup deletes the just-created row on error).
   */
  bootReady: (privateKey: Uint8Array) => Promise<void>
}

export interface WebServer {
  stop(): Promise<void>
  url: string
}

export function startWebServer(deps: WebServerDeps): WebServer {
  const { cfg, db, state, sseHub, bootReady } = deps

  const redirectToSetup = (): Response => Response.redirect('/setup', 303)

  // All non-/setup routes funnel through this guard. If we're in setup
  // mode, bounce to /setup; otherwise hand back the ready-mode handles so
  // the caller doesn't have to re-narrow state.current.
  const requireReady = ():
    | { ok: true; ready: Extract<AppState, { mode: 'ready' }> }
    | { ok: false; response: Response } => {
    if (state.current.mode !== 'ready') {
      return { ok: false, response: redirectToSetup() }
    }
    return { ok: true, ready: state.current }
  }

  const server = Bun.serve({
    port: cfg.httpPort,
    hostname: cfg.httpBind,
    routes: {
      '/setup': {
        GET: () => {
          if (state.current.mode === 'ready') return Response.redirect('/', 303)
          return htmlResponse(setupView())
        },
        POST: async (req) => {
          if (state.current.mode === 'ready') return Response.redirect('/', 303)
          const form = await req.formData()
          const mode = form.get('mode')

          let privateKey: Uint8Array
          let generated = false
          try {
            if (mode === 'generate') {
              privateKey = generatePrivateKey()
              generated = true
            } else if (mode === 'paste') {
              const raw = form.get('nsec')
              if (typeof raw !== 'string' || raw.trim() === '') {
                return htmlResponse(setupView({ error: 'nsec is required' }), { status: 400 })
              }
              privateKey = parseNsecInput(raw)
            } else {
              return htmlResponse(setupView({ error: 'invalid setup mode' }), { status: 400 })
            }
          } catch (err) {
            return htmlResponse(
              setupView({
                error: `Could not parse nsec: ${err instanceof Error ? err.message : String(err)}`,
                pastedNsec: typeof form.get('nsec') === 'string' ? (form.get('nsec') as string) : '',
              }),
              { status: 400 },
            )
          }

          const account = createAccount(db, privateKey)
          try {
            await bootReady(privateKey)
          } catch (err) {
            // Wallet/Boltz/relay bring-up failed. Undo the row so the user
            // can retry without a half-configured DB. The just-generated
            // (or pasted) nsec is only in memory here — surface it in the
            // error so a generate run doesn't silently lose the key.
            db.query('DELETE FROM accounts WHERE id = ?').run(account.id)
            const detail = err instanceof Error ? err.message : String(err)
            return htmlResponse(
              setupView({
                error:
                  `Saved the account but failed to start the wallet: ${detail}. ` +
                  (generated
                    ? `The generated nsec was: ${nip19.nsecEncode(privateKey)} — save it if you want to retry with the same key.`
                    : 'Try again.'),
              }),
              { status: 500 },
            )
          }

          if (generated) {
            return htmlResponse(setupGeneratedView({ nsec: nip19.nsecEncode(privateKey) }))
          }
          return Response.redirect('/', 303)
        },
      },
      '/': {
        GET: async () => {
          const r = requireReady()
          if (!r.ok) return r.response
          const balance = await r.ready.wallet.getBalance()
          const { active } = listAllConnections(db)
          const txCountRow = db
            .query<{ c: number }, []>(
              `SELECT COUNT(*) AS c FROM transactions WHERE state = 'settled'`,
            )
            .get()
          return htmlResponse(
            dashboardView({
              balanceMsat: (balance.available + balance.recoverable) * 1000,
              arkAddress: r.ready.arkAddress,
              activeConnections: active.length,
              totalTxCount: txCountRow?.c ?? 0,
            }),
          )
        },
      },
      '/connections': {
        GET: () => {
          const r = requireReady()
          if (!r.ok) return r.response
          const { active, revoked } = listAllConnections(db)
          return htmlResponse(
            connectionsListView({
              active,
              revoked,
              relays: r.ready.nostr.getRelayStatus(),
            }),
          )
        },
      },
      '/connections/new': {
        GET: () => {
          const r = requireReady()
          if (!r.ok) return r.response
          return htmlResponse(newConnectionForm())
        },
        POST: async (req) => {
          const r = requireReady()
          if (!r.ok) return r.response
          const form = await req.formData()
          const rawLabel = form.get('label')
          const rawBudget = form.get('budget_sats')
          const label =
            typeof rawLabel === 'string' && rawLabel.trim() !== '' ? rawLabel.trim() : null
          const budgetSatsStr =
            typeof rawBudget === 'string' && rawBudget.trim() !== '' ? rawBudget.trim() : null

          let budgetMsat: number | null = null
          if (budgetSatsStr !== null) {
            const n = Number.parseInt(budgetSatsStr, 10)
            if (!Number.isFinite(n) || n < 0 || String(n) !== budgetSatsStr) {
              return htmlResponse(
                newConnectionForm({
                  error: 'budget must be a non-negative integer (sats)',
                  label: label ?? undefined,
                  budgetSats: budgetSatsStr,
                }),
                { status: 400 },
              )
            }
            budgetMsat = n * 1000
          }

          const { connection, uri } = createConnection(db, {
            label,
            relays: cfg.nwcRelays,
            budgetMsat,
          })
          // Publish the info event and start listening for requests
          // immediately — without this, the client wouldn't see kind 13194
          // until the next bridge restart and would refuse to connect.
          // publishToRelays inside is best-effort, so a flaky relay won't
          // block the response.
          await r.ready.nostr.registerConnection(connection)
          return htmlResponse(
            newConnectionResultView({
              connectionId: connection.id,
              uri,
              qrSvg: qrSvg(uri),
            }),
          )
        },
      },
      '/connections/:id': {
        GET: (req) => {
          const r = requireReady()
          if (!r.ok) return r.response
          const id = Number.parseInt(req.params.id, 10)
          if (!Number.isFinite(id)) return new Response('Invalid id', { status: 400 })
          const conn = findConnectionById(db, id)
          if (!conn) return new Response('Not found', { status: 404 })
          const transactions = db
            .query<TransactionRow, [number]>(
              `SELECT * FROM transactions WHERE connection_id = ? ORDER BY created_at DESC LIMIT 200`,
            )
            .all(id)
          return htmlResponse(
            connectionDetailView({
              conn,
              transactions,
              relays: r.ready.nostr.getRelayStatus(),
            }),
          )
        },
      },
      '/connections/:id/revoke': {
        POST: (req) => {
          const r = requireReady()
          if (!r.ok) return r.response
          const id = Number.parseInt(req.params.id, 10)
          if (!Number.isFinite(id)) {
            return new Response('Invalid id', { status: 400 })
          }
          // Look up the connection before flipping revoked_at so we can
          // tell the nostr service which service pubkey to drop. After
          // the UPDATE, listActiveConnections / findConnectionByServicePubkey
          // both treat the row as gone, so this has to happen first.
          const conn = findConnectionById(db, id)
          revokeConnection(db, id)
          if (conn) r.ready.nostr.unregisterConnection(conn.servicePubkeyHex)
          return Response.redirect('/connections', 303)
        },
      },
      '/history': {
        GET: async () => {
          const r = requireReady()
          if (!r.ok) return r.response
          // Raw ark-side wallet history — every onchain/offchain movement
          // the wallet sees. NWC accountability lives on the per-connection
          // detail page; we don't try to correlate the two here.
          const txs = await r.ready.wallet.getTransactionHistory()
          return htmlResponse(walletHistoryView(txs))
        },
      },
      '/events': {
        GET: (req) => {
          // Server-Sent Events feed for live UI updates. Open one per
          // browser tab; nostr-side and (later) wallet-side state changes
          // get fanned out through sseHub.broadcast.
          let active: ReadableStreamDefaultController<Uint8Array> | null = null
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              active = controller
              sseHub.add(controller)
              if (state.current.mode === 'ready') {
                sseHub.sendTo(
                  controller,
                  'relay-status',
                  relayStatusPayload(state.current.nostr.getRelayStatus()),
                )
              }
            },
            cancel() {
              if (active) sseHub.remove(active)
            },
          })
          // req.signal aborts on client disconnect; without this the
          // controller leaks into sseHub forever and every broadcast
          // tries to enqueue into a dead stream.
          req.signal.addEventListener('abort', () => {
            if (active) {
              sseHub.remove(active)
              try {
                active.close()
              } catch {
                // already closed
              }
            }
          })
          return new Response(stream, {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
            },
          })
        },
      },
    },
    fetch: () => new Response('Not Found', { status: 404 }),
  })

  // Read server.port instead of cfg.httpPort — they differ when cfg.httpPort
  // is 0 (tests bind to an OS-picked port).
  return {
    stop: async () => {
      server.stop()
    },
    url: `http://${cfg.httpBind}:${server.port}`,
  }
}
