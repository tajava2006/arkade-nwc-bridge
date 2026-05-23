import type { Database } from 'bun:sqlite'
import type { Wallet } from '@arkade-os/sdk'

import type { Config } from '../config'
import { htmlResponse } from '../lib/html'
import {
  createConnection,
  findConnectionById,
  listAllConnections,
  revokeConnection,
} from '../nostr/connections'
import type { TransactionRow } from '../lib/transaction'
import { dashboardView } from './views/dashboard'
import { connectionsListView } from './views/connections'
import { newConnectionForm, newConnectionResultView } from './views/new_connection'
import { walletHistoryView } from './views/history'
import { connectionDetailView } from './views/connection_detail'
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
              `SELECT COUNT(*) AS c FROM transactions WHERE state = 'settled'`,
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
          // until the next bridge restart — bundled with the kind-5
          // revoke-deletion path in the phase 10 cleanup.
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
          const id = Number.parseInt(req.params.id, 10)
          if (!Number.isFinite(id)) return new Response('Invalid id', { status: 400 })
          const conn = findConnectionById(db, id)
          if (!conn) return new Response('Not found', { status: 404 })
          const transactions = db
            .query<TransactionRow, [number]>(
              `SELECT * FROM transactions WHERE connection_id = ? ORDER BY created_at DESC LIMIT 200`,
            )
            .all(id)
          return htmlResponse(connectionDetailView({ conn, transactions }))
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
        GET: async () => {
          // Raw ark-side wallet history — every onchain/offchain movement
          // the wallet sees. NWC accountability lives on the per-connection
          // detail page; we don't try to correlate the two here.
          const txs = await wallet.getTransactionHistory()
          return htmlResponse(walletHistoryView(txs))
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
