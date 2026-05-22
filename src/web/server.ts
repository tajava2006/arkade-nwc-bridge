import type { Database } from 'bun:sqlite'
import type { Wallet } from '@arkade-os/sdk'

import type { Config } from '../config'
import { htmlResponse } from '../lib/html'
import {
  createConnection,
  listAllConnections,
  revokeConnection,
} from '../nostr/connections'
import { dashboardView } from './views/dashboard'
import { connectionsListView } from './views/connections'
import { newConnectionForm, newConnectionResultView } from './views/new_connection'
import { historyView, type HistoryRow } from './views/history'
import { qrSvg } from './qr'

export interface WebServerDeps {
  cfg: Config
  db: Database
  wallet: Wallet
  arkAddress: string
}

export interface WebServer {
  stop(): Promise<void>
  url: string
}

interface HistoryRowSql {
  type: 'incoming' | 'outgoing'
  state: string
  amount_msat: number
  fees_paid_msat: number | null
  description: string | null
  payment_hash: string
  created_at: number
  settled_at: number | null
}

export function startWebServer(deps: WebServerDeps): WebServer {
  const { cfg, db, wallet, arkAddress } = deps

  const server = Bun.serve({
    port: cfg.httpPort,
    hostname: cfg.httpBind,
    routes: {
      '/': {
        GET: async () => {
          const balance = await wallet.getBalance()
          const { active } = listAllConnections(db)
          const txCountRow = db
            .query<{ c: number }, []>(
              `SELECT
                 (SELECT COUNT(*) FROM invoices WHERE state = 'settled')
                 + (SELECT COUNT(*) FROM payments WHERE state = 'settled') AS c`,
            )
            .get()
          return htmlResponse(
            dashboardView({
              balanceMsat: (balance.available + balance.recoverable) * 1000,
              arkAddress,
              activeConnections: active.length,
              totalTxCount: txCountRow?.c ?? 0,
            }),
          )
        },
      },
      '/connections': {
        GET: () => {
          const { active, revoked } = listAllConnections(db)
          return htmlResponse(connectionsListView({ active, revoked }))
        },
      },
      '/connections/new': {
        GET: () => htmlResponse(newConnectionForm()),
        POST: async (req) => {
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
          // The kind 13194 info event for this connection isn't published
          // until the next bridge restart — keeping the publish path on
          // the startup sweep is simpler than threading the SimplePool
          // through the web layer here, and the operator can already see
          // the URI immediately. Wiring live publish on create lands with
          // the phase 10 cleanup pass.
          return htmlResponse(
            newConnectionResultView({
              connectionId: connection.id,
              uri,
              qrSvg: qrSvg(uri),
            }),
          )
        },
      },
      '/connections/:id/revoke': {
        POST: (req) => {
          const id = Number.parseInt(req.params.id, 10)
          if (!Number.isFinite(id)) {
            return new Response('Invalid id', { status: 400 })
          }
          revokeConnection(db, id)
          return Response.redirect('/connections', 303)
        },
      },
      '/history': {
        GET: () => {
          // Merge incoming + outgoing into a single feed. Volumes for a
          // self-hosted personal bridge stay tiny, so an in-memory merge
          // beats hand-writing a UNION query with consistent column lists
          // across two schemas.
          const incoming = db
            .query<HistoryRowSql, []>(
              `SELECT
                 'incoming' AS type, state, amount_msat, fees_paid_msat, description,
                 payment_hash, created_at, settled_at
               FROM invoices`,
            )
            .all()
          const outgoing = db
            .query<HistoryRowSql, []>(
              `SELECT
                 'outgoing' AS type, state, amount_msat, fees_paid_msat,
                 NULL AS description, payment_hash, created_at, settled_at
               FROM payments`,
            )
            .all()
          const merged: HistoryRow[] = [...incoming, ...outgoing].sort(
            (a, b) => b.created_at - a.created_at,
          )
          return htmlResponse(historyView(merged))
        },
      },
    },
    fetch: () => new Response('Not Found', { status: 404 }),
  })

  return {
    stop: async () => {
      server.stop()
    },
    url: `http://${cfg.httpBind}:${cfg.httpPort}`,
  }
}
