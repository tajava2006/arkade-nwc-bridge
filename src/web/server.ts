import type { Database } from 'bun:sqlite'
import type { Wallet, WalletBalance, RestArkProvider } from '@arkade-os/sdk'
import { decodeInvoice, type ArkadeSwaps } from '@arkade-os/boltz-swap'

import type { Config } from '../config'
import { sendLightning } from '../ln_send'
import { createAccount, generatePrivateKey, parseNsecInput } from '../account'
import { nip19 } from 'nostr-tools'
import type { SimplePool } from 'nostr-tools/pool'
import { cycleSpentMsat, parseBudgetRenewal, type BudgetRenewal } from '../lib/budget'
import { html, htmlResponse } from '../lib/html'
import {
  createConnection,
  findConnectionById,
  listAllConnections,
  revokeConnection,
} from '../nostr/connections'
import type { NostrService } from '../nostr/service'
import type { OfferService } from '../clink/offers'
import type { ProofSyncService } from '../exit/sync_service'
import type { ExitEngine } from '../exit/engine'
import { estimateExit } from '../exit/estimate'
import {
  gcOrphanProofs,
  getVaultVtxo,
  isVtxoExitReady,
  listVaultVtxos,
  removeVtxo,
} from '../exit/vault'
import { getExitOp } from '../exit/ops'
import { exitFinalError, exitView, type ExitRow } from './views/exit'
import {
  exitActionError,
  exitDetailView,
  exitSweepError,
  stepLine,
  sweepStatusLine,
} from './views/exit_detail'
import { buildExitStepper, probeExitStep } from '../exit/stepper'
import { nofferDecode, OfferPriceType } from '../clink/nip19_offer'
import { requestNofferInvoice, clinkErrorMessage } from '../clink/send'
import type { OutboxWatcher } from '../nostr/outbox'
import type { SseHub } from '../lib/sse'
import type { AsyncCache } from '../lib/cache'
import {
  connectionRelayPayload,
  outboxPanelPayload,
  type RelayStatus,
} from '../lib/relay_status'
import type { TransactionRow } from '../lib/transaction'
import { dashboardView } from './views/dashboard'
import { connectionsListView } from './views/connections'
import { newConnectionForm, newConnectionResultView } from './views/new_connection'
import { connectionDetailView } from './views/connection_detail'
import { setupGeneratedView, setupView } from './views/setup'
import { degradedView } from './views/degraded'
import { vaultStats } from '../exit/vault'

import {
  sendView,
  sendConfirmView,
  sendResultView,
  submittedView,
  renderOffboardsFragment,
} from './views/send'
import { qrSvg } from './qr'
import { Ramps } from '@arkade-os/sdk'
import {
  classifyDestination,
  classifyVtxos,
  lightningPreview,
  offboardFeeSat,
  offboardMaxSat,
  type SendData,
} from '../send'
import {
  createOffboard,
  listRecentOffboards,
  markOffboardFailed,
  markOffboardSettled,
} from '../offboards'

export interface SwrCaches {
  balance: AsyncCache<WalletBalance>
  // ArkInfo + VTXOs for the /send breakdown, fetched together (SEND_DESIGN §7).
  sendData: AsyncCache<SendData>
}

export type AppState =
  | { mode: 'setup' }
  | {
      // Account exists but the full bring-up (wallet/boltz/nostr) failed —
      // typically the ASP or Boltz being unreachable, which is exactly the
      // scenario unilateral exit exists for (EXIT_PLAN #07). Everything here
      // works without the ASP: the vault is sqlite, the onchain address is
      // derived from the nsec. index.ts retries the full boot every 60s and
      // promotes in place; open tabs reload on the 'mode-change' SSE event.
      mode: 'degraded'
      error: string
      since: number
      attempts: number
      // nsec-derived plain P2TR — CPFP fuel + sweep destination (EXIT_PLAN §2.4)
      onchainAddress: string
      // exit engine runs in BOTH non-setup modes (vault + nsec + esplora only)
      exitEngine: ExitEngine
    }
  | {
      mode: 'ready'
      wallet: Wallet
      swaps: ArkadeSwaps
      nostr: NostrService
      offers: OfferService
      caches: SwrCaches
      // Shared SimplePool (same instance the nostr/offer subsystems use) —
      // /send needs it to resolve a CLINK noffer to an invoice (SEND_DESIGN §9).
      pool: SimplePool
      arkAddress: string
      // Onchain (boarding) receive handle + the ASP onboarding intent-fee
      // program (onchain-input CEL string), snapshotted at boot for the
      // dashboard's receive section.
      boardingAddress: string
      onboardingFeeProgram?: string
      // Used by /send to read ArkInfo (dust + intent-fee programs) for the
      // VTXO breakdown and offboard fee preview. A second RestArkProvider
      // alongside the wallet's internal one is fine — it's stateless REST.
      arkProvider: RestArkProvider
      // Exit-proof mirroring scheduler (EXIT_PLAN #05) — the dashboard reads
      // its snapshot for the readiness tile; live updates ride SSE.
      proofSync: ProofSyncService
      exitEngine: ExitEngine
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
  outbox: OutboxWatcher
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
  const { cfg, db, state, sseHub, outbox, bootReady } = deps

  const redirectToSetup = (): Response => Response.redirect('/setup', 303)

  const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  const fmtSats = (n: number): string => `${n.toLocaleString()} sats`

  const sendError = (label: string, detail: string): Response =>
    htmlResponse(sendResultView({ label, ok: false, detail }), { status: 400 })

  // Parse a positive-integer sats amount from form input. null = invalid.
  const parseSats = (raw: string): number | null => {
    const s = raw.trim()
    const n = Number.parseInt(s, 10)
    if (!Number.isFinite(n) || n <= 0 || String(n) !== s) return null
    return n
  }

  // Re-render the offboards fragment to every open tab. Called after a row is
  // inserted (pending) and again when its background promise settles/fails.
  const broadcastOffboards = (): void => {
    sseHub.broadcast('offboards-update', {
      html: renderOffboardsFragment(listRecentOffboards(db)).value,
    })
  }

  // All ready-only routes funnel through this guard: setup mode bounces to
  // /setup, degraded mode bounces to / (the degraded status page — the only
  // meaningful place until the exit tab lands). Otherwise hand back the
  // ready-mode handles so the caller doesn't have to re-narrow state.current.
  const requireReady = ():
    | { ok: true; ready: Extract<AppState, { mode: 'ready' }> }
    | { ok: false; response: Response } => {
    if (state.current.mode === 'setup') {
      return { ok: false, response: redirectToSetup() }
    }
    if (state.current.mode === 'degraded') {
      return { ok: false, response: Response.redirect('/', 303) }
    }
    return { ok: true, ready: state.current }
  }

  const server = Bun.serve({
    port: cfg.httpPort,
    hostname: cfg.httpBind,
    // Bun's default (10s) also cuts off responses still waiting on upstream
    // reads — routes that touch esplora (feeRate/funding/step probes) need
    // the headroom on a slow day
    idleTimeout: 30,
    routes: {
      '/setup': {
        GET: () => {
          if (state.current.mode !== 'setup') return Response.redirect('/', 303)
          return htmlResponse(setupView())
        },
        POST: async (req) => {
          if (state.current.mode !== 'setup') return Response.redirect('/', 303)
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
        GET: () => {
          if (state.current.mode === 'degraded') {
            return htmlResponse(degradedView({ state: state.current, stats: vaultStats(db) }))
          }
          const r = requireReady()
          if (!r.ok) return r.response
          // SWR: hand back the last cached balance immediately, kick off
          // a background refresh whose result lands via SSE. First visit
          // ever in this process renders "Loading…" until the fetch
          // resolves; subsequent visits flash the cached value, then
          // (sub-second) get the fresh one without a page reload.
          const { value: balance } = r.ready.caches.balance.snapshot()
          void r.ready.caches.balance.refresh()
          const { active } = listAllConnections(db)
          return htmlResponse(
            dashboardView({
              balance,
              exitReadiness: r.ready.proofSync.snapshot(),
              arkAddress: r.ready.arkAddress,
              boardingAddress: r.ready.boardingAddress,
              onboardingFeeProgram: r.ready.onboardingFeeProgram,
              noffer: r.ready.offers.snapshot().noffer,
              offerRelay: r.ready.offers.getRelayStatus(),
              activeConnections: active.length,
            }),
          )
        },
      },
      '/exit': {
        GET: async () => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          // ready AND degraded — this page must hold with the ASP dead
          const feeRate = await st.exitEngine.feeRate()
          const nowSec = Math.floor(Date.now() / 1000)
          const rows: ExitRow[] = listVaultVtxos(db).map((vtxo) => {
            // one corrupt row must not 500 the emergency page — render it
            // unpriced instead
            let estimate = null
            try {
              estimate = estimateExit(db, vtxo.txid, vtxo.vout, feeRate)
            } catch {
              estimate = null
            }
            return {
              vtxo,
              ready: isVtxoExitReady(db, vtxo.txid, vtxo.vout),
              estimate,
              op: getExitOp(db, vtxo.txid, vtxo.vout),
            }
          })
          const funding = await st.exitEngine.fundingStatus()
          const dest = st.exitEngine.destStatus()
          // priced only when a send exists; a failed esplora read degrades to
          // "status unknown" instead of blocking the emergency page
          let sendInfo = null
          if (dest?.sendTxid) {
            try {
              sendInfo = await st.exitEngine.finalSendInfo()
            } catch {
              sendInfo = null
            }
          }
          return htmlResponse(
            exitView({
              rows,
              feeRate,
              degraded: st.mode === 'degraded',
              stats: vaultStats(db),
              nowSec,
              fundingAddress: funding.address,
              fundingBalanceSat: funding.balanceSat,
              dest,
              summary: st.exitEngine.exitSummary(),
              sendInfo,
            }),
          )
        },
      },
      '/exit/:txid/:vout': {
        GET: async (req) => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          const { txid } = req.params
          const vout = Number.parseInt(req.params.vout, 10)
          if (!Number.isInteger(vout)) return new Response('bad vout', { status: 400 })
          const feeRate = await st.exitEngine.feeRate()
          const stepper = buildExitStepper({ db }, txid, vout, feeRate)
          if (!stepper) return new Response('no such vtxo in the exit vault', { status: 404 })
          let estimate = null
          try {
            estimate = estimateExit(db, txid, vout, feeRate)
          } catch {
            estimate = null
          }
          const funding = await st.exitEngine.fundingStatus()
          const vaultRow = getVaultVtxo(db, txid, vout)
          const dest = st.exitEngine.destStatus()
          return htmlResponse(
            exitDetailView({
              stepper,
              estimate,
              funding,
              verifiedDest: dest?.verifiedAt ? dest.address : null,
              degraded: st.mode === 'degraded',
              quarantine:
                vaultRow && vaultRow.quarantinedAt !== null
                  ? {
                      at: vaultRow.quarantinedAt,
                      reason: vaultRow.quarantineReason,
                      expired:
                        vaultRow.expiresAt !== null &&
                        vaultRow.expiresAt <= Math.floor(Date.now() / 1000),
                    }
                  : null,
            }),
          )
        },
      },
      // One onchain status probe per request, fetched by the detail page's
      // fill-in loop after render — the initial stepper is DB-only so a long
      // chain can't stall the page (see statusFillIn in views/exit_detail.ts).
      '/exit/:txid/:vout/step/:stepTxid': {
        GET: async (req) => {
          const st = state.current
          if (st.mode === 'setup') return new Response('setup required', { status: 409 })
          const { txid, stepTxid } = req.params
          const vout = Number.parseInt(req.params.vout, 10)
          if (!Number.isInteger(vout)) return new Response('bad vout', { status: 400 })
          let explorer
          try {
            explorer = await st.exitEngine.explorer()
          } catch {
            return new Response('esplora unavailable', { status: 503 })
          }
          const probe = await probeExitStep({ db, explorer }, txid, vout, stepTxid)
          if (!probe) return new Response('no such step', { status: 404 })
          // a step sitting in the mempool gets its fee context (package rate
          // vs next block, boost button) — priced best-effort, the plain
          // status line renders regardless
          let boost = null
          if (probe.status === 'mempool') {
            try {
              const info = await st.exitEngine.stepBoostInfo(txid, vout, stepTxid)
              if (info) boost = { txid, vout, info }
            } catch {
              // unpriceable — plain line
            }
          }
          return Response.json({
            status: probe.status,
            stepHtml: stepLine(probe.step, boost).value,
            waitHtml: probe.wait ? stepLine(probe.wait).value : undefined,
            sweepHtml: probe.sweep ? stepLine(probe.sweep).value : undefined,
          })
        },
      },
      // Fee/confirmation status of the sweep tx once an op is 'swept' —
      // fetched by the detail page after render, same pattern as the step
      // probes. 204 = nothing to correct (no sweep, or esplora can't see it).
      '/exit/:txid/:vout/sweep-status': {
        GET: async (req) => {
          const st = state.current
          if (st.mode === 'setup') return new Response('setup required', { status: 409 })
          const { txid } = req.params
          const vout = Number.parseInt(req.params.vout, 10)
          if (!Number.isInteger(vout)) return new Response('bad vout', { status: 400 })
          const feeRate = await st.exitEngine.feeRate()
          const stepper = buildExitStepper({ db }, txid, vout, feeRate)
          if (!stepper) return new Response('no such vtxo in the exit vault', { status: 404 })
          let info = null
          try {
            info = await st.exitEngine.sweepBoostInfo(txid, vout)
          } catch {
            info = null
          }
          if (!info) return new Response(null, { status: 204 })
          return Response.json({
            sweepHtml: sweepStatusLine(txid, vout, stepper.sweep, info).value,
          })
        },
      },
      // One-button fee boost for a stuck unroll package: replace its CPFP
      // child at the next-block rate (single preset on purpose — the user
      // shouldn't be asked to pick a fee rate mid-emergency).
      '/exit/:txid/:vout/boost/:stepTxid': {
        POST: async (req) => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          const { txid, stepTxid } = req.params
          const vout = Number.parseInt(req.params.vout, 10)
          if (!Number.isInteger(vout)) return new Response('bad vout', { status: 400 })
          try {
            await st.exitEngine.boostStep(txid, vout, stepTxid)
          } catch (err) {
            return htmlResponse(
              exitActionError('Boost', txid, vout, err instanceof Error ? err.message : String(err)),
              { status: 400 },
            )
          }
          return Response.redirect(`/exit/${txid}/${vout}`, 303)
        },
      },
      '/exit/:txid/:vout/boost-sweep': {
        POST: async (req) => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          const { txid } = req.params
          const vout = Number.parseInt(req.params.vout, 10)
          if (!Number.isInteger(vout)) return new Response('bad vout', { status: 400 })
          try {
            await st.exitEngine.boostSweep(txid, vout)
          } catch (err) {
            return htmlResponse(
              exitActionError('Boost', txid, vout, err instanceof Error ? err.message : String(err)),
              { status: 400 },
            )
          }
          return Response.redirect(`/exit/${txid}/${vout}`, 303)
        },
      },
      '/exit/:txid/:vout/start': {
        POST: (req) => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          const { txid } = req.params
          const vout = Number.parseInt(req.params.vout, 10)
          if (!Number.isInteger(vout)) return new Response('bad vout', { status: 400 })
          // fire-and-forget: the engine queues + drives the op, progress
          // streams back over the exit-op SSE event
          st.exitEngine.startExit(txid, vout)
          return Response.redirect(`/exit/${txid}/${vout}`, 303)
        },
      },
      // Operator override for a quarantined row: "I can explain this
      // disappearance myself (e.g. spent from another wallet in a way the
      // bridge can't verify) — stop keeping its proofs." Destructive on
      // purpose and quarantine-gated: evidence-verified rows never need it
      // and live rows must not be droppable by a misclick.
      '/exit/:txid/:vout/forget': {
        POST: (req) => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          const { txid } = req.params
          const vout = Number.parseInt(req.params.vout, 10)
          if (!Number.isInteger(vout)) return new Response('bad vout', { status: 400 })
          const row = getVaultVtxo(db, txid, vout)
          if (!row) return new Response('no such vtxo in the exit vault', { status: 404 })
          if (row.quarantinedAt === null) {
            return new Response('only quarantined vtxos can be forgotten', { status: 409 })
          }
          removeVtxo(db, txid, vout)
          gcOrphanProofs(db)
          return Response.redirect('/exit', 303)
        },
      },
      '/exit/:txid/:vout/sweep': {
        POST: async (req) => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          const { txid } = req.params
          const vout = Number.parseInt(req.params.vout, 10)
          if (!Number.isInteger(vout)) return new Response('bad vout', { status: 400 })
          try {
            // dest=verified routes the sweep straight to the challenge-verified
            // final-send address (skips the fuel hop); anything else = default
            let destAddress: string | undefined
            const form = await req.formData().catch(() => null)
            if (form?.get('dest') === 'verified') {
              const dest = st.exitEngine.destStatus()
              if (!dest?.verifiedAt) {
                throw new Error('no challenge-verified destination on file')
              }
              destAddress = dest.address
            }
            await st.exitEngine.sweep([{ txid, vout }], destAddress)
          } catch (err) {
            return htmlResponse(
              exitSweepError(txid, vout, err instanceof Error ? err.message : String(err)),
              { status: 400 },
            )
          }
          return Response.redirect(`/exit/${txid}/${vout}`, 303)
        },
      },
      '/exit/dest': {
        POST: async (req) => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          const form = await req.formData()
          const address = String(form.get('address') ?? '')
          const result = st.exitEngine.issueDest(address)
          if (!result.ok) {
            return htmlResponse(exitFinalError('Challenge', result.reason), { status: 400 })
          }
          return Response.redirect('/exit', 303)
        },
      },
      '/exit/dest/verify': {
        POST: async (req) => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          const form = await req.formData()
          const signature = String(form.get('signature') ?? '')
          const result = st.exitEngine.verifyDest(signature)
          if (!result.ok) {
            return htmlResponse(exitFinalError('Signature verification', result.reason), {
              status: 400,
            })
          }
          return Response.redirect('/exit', 303)
        },
      },
      '/exit/dest/clear': {
        POST: () => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          st.exitEngine.clearDest()
          return Response.redirect('/exit', 303)
        },
      },
      '/exit/final-send': {
        POST: async () => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          try {
            await st.exitEngine.finalSend()
          } catch (err) {
            return htmlResponse(
              exitFinalError('Final send', err instanceof Error ? err.message : String(err)),
              { status: 400 },
            )
          }
          return Response.redirect('/exit', 303)
        },
      },
      '/exit/final-send/boost': {
        POST: async () => {
          const st = state.current
          if (st.mode === 'setup') return redirectToSetup()
          try {
            await st.exitEngine.boostFinalSend()
          } catch (err) {
            return htmlResponse(
              exitFinalError('Final-send boost', err instanceof Error ? err.message : String(err)),
              { status: 400 },
            )
          }
          return Response.redirect('/exit', 303)
        },
      },
      '/connections': {
        GET: () => {
          const r = requireReady()
          if (!r.ok) return r.response
          const { active, revoked } = listAllConnections(db)
          const connectionStatuses = new Map<number, RelayStatus[]>()
          const spentNowMsat = new Map<number, number>()
          const now = new Date()
          for (const c of active) {
            connectionStatuses.set(c.id, r.ready.nostr.getRelayStatus(c.relays))
            spentNowMsat.set(c.id, cycleSpentMsat(db, c, now))
          }
          return htmlResponse(
            connectionsListView({
              active,
              revoked,
              connectionStatuses,
              spentNowMsat,
              outboxPanel: {
                bootstrap: outbox.getBootstrapRelayStatus(),
                outbox: outbox.getOutboxRelayStatus(),
                outboxSource: outbox.getOutboxSource(),
              },
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
                  budgetRenewal:
                    typeof form.get('budget_renewal') === 'string'
                      ? (form.get('budget_renewal') as string)
                      : undefined,
                }),
                { status: 400 },
              )
            }
            budgetMsat = n * 1000
          }

          // Renewal is meaningless without a cap — unlimited connections are
          // stored as 'never' regardless of what the form said. Missing/empty
          // field also defaults to 'never' (lenient for hand-rolled POSTs);
          // only an explicit unknown value is rejected.
          const rawRenewal = form.get('budget_renewal')
          let budgetRenewal: BudgetRenewal = 'never'
          if (budgetMsat !== null && typeof rawRenewal === 'string' && rawRenewal !== '') {
            const parsed = parseBudgetRenewal(rawRenewal)
            if (parsed === null) {
              return htmlResponse(
                newConnectionForm({
                  error: 'budget renewal must be one of: never, daily, weekly, monthly',
                  label: label ?? undefined,
                  budgetSats: budgetSatsStr ?? undefined,
                }),
                { status: 400 },
              )
            }
            budgetRenewal = parsed
          }

          const { connection, uri } = createConnection(db, {
            label,
            // Snapshot the outbox at this moment — the URI baking it
            // in is what NWC clients will use forever, even if the
            // outbox list changes later.
            relays: outbox.getOutboxRelays(),
            budgetMsat,
            budgetRenewal,
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
              spentNowMsat: cycleSpentMsat(db, conn, new Date()),
              transactions,
              relays: r.ready.nostr.getRelayStatus(conn.relays),
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
      '/noffer/regenerate': {
        // Operator-initiated: mint a fresh noffer from the current outbox
        // relay (e.g. after swapping a flaky relay out of the NIP-65 list)
        // and move the subscription to it. Invalidates previously shared
        // copies of the old code — that's the point.
        POST: () => {
          const r = requireReady()
          if (!r.ok) return r.response
          r.ready.offers.regenerate()
          return Response.redirect('/', 303)
        },
      },
      '/send': {
        GET: async () => {
          const r = requireReady()
          if (!r.ok) return r.response
          // SWR: render from the cached snapshot instantly (or a loading
          // placeholder on a cold cache), then refresh in the background and
          // push the fresh breakdown over SSE. Same pattern as dashboard.
          const { value } = r.ready.caches.sendData.snapshot()
          void r.ready.caches.sendData.refresh()
          return htmlResponse(
            sendView({
              value,
              offboards: listRecentOffboards(db),
            }),
          )
        },
        // Review step: parse + classify + compute the full breakdown (what's
        // billed, the fee, and the total leaving the wallet), then render a
        // confirm page. No funds move here — /send/confirm executes.
        POST: async (req) => {
          const r = requireReady()
          if (!r.ok) return r.response
          const ready = r.ready
          const form = await req.formData()
          const destination = (form.get('destination') ?? '').toString().trim()
          const amountRaw = (form.get('amount') ?? '').toString()
          const isMax = (form.get('max') ?? '').toString() === '1'

          const rail = classifyDestination(destination)
          if (!rail) return sendError('send', 'destination is required')

          if (rail === 'clink') {
            // Resolve the noffer to a bolt11, then fold into the LN confirm
            // path (SEND_DESIGN §9). Amount is required unless the offer is
            // fixed-price; we decode to learn that.
            let pointer
            try {
              pointer = nofferDecode(destination)
            } catch (err) {
              return sendError('clink', `invalid noffer: ${errMsg(err)}`)
            }
            let amountSats: number | undefined
            if (pointer.priceType !== OfferPriceType.Fixed) {
              const a = parseSats(amountRaw)
              if (a === null) return sendError('clink', 'amount is required for this offer (sats)')
              amountSats = a
            }
            let result = await requestNofferInvoice({ pool: ready.pool, noffer: destination, amountSats })
            // code 3 (expired/moved) with a forwarding `latest` → retry once.
            if (!result.ok && result.kind === 'error' && result.code === 3 && result.latest) {
              result = await requestNofferInvoice({ pool: ready.pool, noffer: result.latest, amountSats })
            }
            if (!result.ok) return sendError('clink', clinkErrorMessage(result))

            let clinkPreview
            try {
              clinkPreview = lightningPreview(result.bolt11, await ready.swaps.getFees())
            } catch (err) {
              return sendError('clink', `offer returned an invalid invoice: ${errMsg(err)}`)
            }
            if (!clinkPreview.amountSats || clinkPreview.amountSats <= 0) {
              return sendError('clink', 'offer returned a 0-amount invoice')
            }
            return htmlResponse(
              sendConfirmView({
                title: 'CLINK offer (Lightning)',
                destination: result.bolt11, // confirm pays the resolved invoice
                amountField: '',
                isMax: false,
                rows: [
                  { label: 'Payee', value: clinkPreview.payee ?? '—' },
                  { label: 'Description', value: clinkPreview.description || '—' },
                  { label: 'Invoice amount', value: fmtSats(clinkPreview.amountSats) },
                  { label: 'Swap fee', value: fmtSats(clinkPreview.feeSat) },
                  { label: 'Total leaving wallet', value: fmtSats(clinkPreview.totalSat) },
                ],
                note: 'Resolved from a CLINK noffer to a Lightning invoice. Confirm pays the invoice; LN routing is handled by Boltz out of the swap fee.',
              }),
            )
          }

          if (rail === 'lightning') {
            let preview
            try {
              preview = lightningPreview(destination, await ready.swaps.getFees())
            } catch (err) {
              return sendError('lightning', `invalid invoice: ${errMsg(err)}`)
            }
            if (!preview.amountSats || preview.amountSats <= 0) {
              return sendError('lightning', '0-amount invoices are not supported')
            }
            return htmlResponse(
              sendConfirmView({
                title: 'Lightning payment',
                destination,
                amountField: '',
                isMax: false,
                rows: [
                  { label: 'Payee', value: preview.payee ?? '—' },
                  { label: 'Description', value: preview.description || '—' },
                  { label: 'Invoice amount', value: fmtSats(preview.amountSats) },
                  { label: 'Swap fee', value: fmtSats(preview.feeSat) },
                  { label: 'Total leaving wallet', value: fmtSats(preview.totalSat) },
                ],
                note: 'LN routing is handled by Boltz out of this fee — the total above is what leaves your wallet.',
              }),
            )
          }

          if (rail === 'ark') {
            const amount = parseSats(amountRaw)
            if (amount === null) return sendError('ark', 'amount must be a positive integer (sats)')
            return htmlResponse(
              sendConfirmView({
                title: 'Ark offchain send',
                destination,
                amountField: String(amount),
                isMax,
                rows: [
                  { label: 'Destination', value: destination },
                  { label: 'Amount', value: fmtSats(amount) },
                  { label: 'Fee', value: fmtSats(0) },
                  { label: 'Total leaving wallet', value: fmtSats(amount) },
                ],
              }),
            )
          }

          // Onchain offboard. The entered amount is what the RECIPIENT gets;
          // the fee is added on top, so total out = amount + fee.
          const arkInfo = await ready.arkProvider.getInfo()
          let recipientSat: number
          let feeSat: number
          let totalOut: number
          if (isMax) {
            const buckets = classifyVtxos(
              await ready.wallet.getVtxos({ withRecoverable: true }),
              arkInfo.dust,
            )
            const max = offboardMaxSat(arkInfo, buckets)
            if (max === null) {
              return sendError('onchain', 'Total minus fee is below dust — cannot offboard.')
            }
            recipientSat = max
            feeSat = offboardFeeSat(arkInfo, buckets.roundTotalSat)
            totalOut = buckets.roundTotalSat
          } else {
            const recipient = parseSats(amountRaw)
            if (recipient === null) {
              return sendError('onchain', 'amount must be a positive integer (sats)')
            }
            recipientSat = recipient
            feeSat = offboardFeeSat(arkInfo, recipient)
            totalOut = recipient + feeSat
          }
          return htmlResponse(
            sendConfirmView({
              title: 'Onchain — collaborative offboard',
              destination,
              amountField: isMax ? String(recipientSat) : amountRaw.trim(),
              isMax,
              rows: [
                { label: 'Destination', value: destination },
                { label: 'Recipient receives', value: fmtSats(recipientSat) },
                { label: 'Offboard fee', value: fmtSats(feeSat) },
                { label: 'Total leaving wallet', value: fmtSats(totalOut) },
              ],
              note: 'Waits for a settlement round to commit (~minutes). Submitted in the background and tracked under "Onchain exits".',
            }),
          )
        },
      },
      '/send/confirm': {
        // Execute the reviewed send. Re-classify the destination (don't trust
        // the round-trip) and run the rail: Ark/LN block (instant–seconds),
        // onchain offboard is fire-and-forget (a round can take >10 min).
        POST: async (req) => {
          const r = requireReady()
          if (!r.ok) return r.response
          const ready = r.ready
          const form = await req.formData()
          const destination = (form.get('destination') ?? '').toString().trim()
          const amountRaw = (form.get('amount') ?? '').toString()
          const isMax = (form.get('max') ?? '').toString() === '1'

          const rail = classifyDestination(destination)
          if (!rail) return sendError('send', 'destination is required')

          if (rail === 'lightning') {
            try {
              const res = await sendLightning(
                {
                  swaps: ready.swaps,
                  wallet: ready.wallet,
                  boltzApiUrl: cfg.boltzApiUrl,
                  arkServerUrl: cfg.arkServerUrl,
                  db,
                },
                destination,
              )
              void ready.caches.balance.refresh()
              void ready.caches.sendData.refresh()
              // Same amount/fee split as everywhere else: the invoice nominal
              // is what the payee got, the gap (swap fee + any drain residue)
              // is our cost — res.amount alone is the fee-inclusive total.
              const nominalSats = decodeInvoice(destination).amountSats ?? 0
              const feeSats = Math.max(0, res.amount - nominalSats)
              return htmlResponse(
                sendResultView({
                  label: 'lightning',
                  ok: true,
                  detail: `paid ${nominalSats} sats (+ ${feeSats} sats fee)\npreimage ${res.preimage}\narkTxid ${res.txid}`,
                }),
              )
            } catch (err) {
              return htmlResponse(
                sendResultView({ label: 'lightning', ok: false, detail: errMsg(err) }),
                { status: 500 },
              )
            }
          }

          if (rail === 'ark') {
            const amount = parseSats(amountRaw)
            if (amount === null) return sendError('ark', 'amount must be a positive integer (sats)')
            try {
              const txid = await ready.wallet.send({ address: destination, amount })
              void ready.caches.balance.refresh()
              void ready.caches.sendData.refresh()
              return htmlResponse(
                sendResultView({ label: 'ark', ok: true, detail: `arkTxid ${txid}` }),
              )
            } catch (err) {
              return htmlResponse(
                sendResultView({ label: 'ark', ok: false, detail: errMsg(err) }),
                { status: 500 },
              )
            }
          }

          // Onchain: collaborative offboard, fire-and-forget. The entered amount
          // is the recipient net; gross allocated = amount + fee so the
          // destination receives exactly what was shown. Max omits the amount
          // for a true drain (a numeric "max" would leave a fee-sized change).
          const arkInfo = await ready.arkProvider.getInfo()
          let amountArg: bigint | undefined
          let recipientSat: number
          let feeSat: number
          if (isMax) {
            const buckets = classifyVtxos(
              await ready.wallet.getVtxos({ withRecoverable: true }),
              arkInfo.dust,
            )
            const max = offboardMaxSat(arkInfo, buckets)
            if (max === null) {
              return sendError('onchain', 'Total minus fee is below dust — cannot offboard.')
            }
            amountArg = undefined
            feeSat = offboardFeeSat(arkInfo, buckets.roundTotalSat)
            recipientSat = max
          } else {
            const recipient = parseSats(amountRaw)
            if (recipient === null) {
              return sendError('onchain', 'amount must be a positive integer (sats)')
            }
            feeSat = offboardFeeSat(arkInfo, recipient)
            recipientSat = recipient
            amountArg = BigInt(recipient + feeSat)
          }

          const row = createOffboard(db, {
            address: destination,
            amountSat: recipientSat,
            feeSat,
            isMax,
          })
          broadcastOffboards()
          void (async () => {
            try {
              const txid = await new Ramps(ready.wallet).offboard(
                destination,
                arkInfo.fees,
                amountArg,
              )
              markOffboardSettled(db, row.id, txid)
            } catch (err) {
              markOffboardFailed(db, row.id, errMsg(err))
            }
            broadcastOffboards()
            void ready.caches.balance.refresh()
            void ready.caches.sendData.refresh()
          })()

          return htmlResponse(
            submittedView({
              title: 'Offboard submitted',
              lines: html`<p>Sending <strong>${recipientSat.toLocaleString()} sats</strong>${isMax ? ' (max)' : ''} to <code>${destination}</code> via a collaborative exit.</p>`,
            }),
          )
        },
      },
      /* TEMP-DISABLED (arkade-os/arkd#1119): consolidate-all trips arkd's
         SETTLEMENT_MIN_EXPIRY_GAP — see the matching commented-out Refresh
         block in views/send.ts. Restore both together.
      '/refresh': {
        // Consolidate-all: wallet.settle() with no params folds every VTXO
        // (incl. sub-dust + swept) + confirmed boarding into one fresh VTXO.
        // Also a settlement round, so fire-and-forget like offboard. Not a
        // money-out action, so no durable row — balance reflects the
        // result over SSE and failures are logged.
        POST: () => {
          const r = requireReady()
          if (!r.ok) return r.response
          const ready = r.ready
          void (async () => {
            try {
              const txid = await ready.wallet.settle()
              console.log(`refresh: consolidated — arkTxid ${txid}`)
            } catch (err) {
              console.error(`refresh failed: ${errMsg(err)}`)
            }
            void ready.caches.balance.refresh()
            void ready.caches.sendData.refresh()
          })()
          return htmlResponse(
            submittedView({
              title: 'Refresh submitted',
              lines: html`<p>Consolidating all VTXOs into one fresh VTXO.</p>`,
            }),
          )
        },
      },
      */
      '/events': {
        GET: (req) => {
          // Server-Sent Events feed for live UI updates. Open one per
          // browser tab; nostr-side and (later) wallet-side state changes
          // get fanned out through sseHub.broadcast.
          let activeCtl: ReadableStreamDefaultController<Uint8Array> | null = null
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              activeCtl = controller
              sseHub.add(controller)
              // Initial snapshots so a freshly-opened tab has current
              // state without waiting for the next change event.
              sseHub.sendTo(
                controller,
                'outbox-update',
                outboxPanelPayload({
                  bootstrap: outbox.getBootstrapRelayStatus(),
                  outbox: outbox.getOutboxRelayStatus(),
                  outboxSource: outbox.getOutboxSource(),
                }),
              )
              if (state.current.mode === 'ready') {
                const ready = state.current
                for (const c of listAllConnections(db).active) {
                  sseHub.sendTo(
                    controller,
                    'connection-update',
                    connectionRelayPayload(c.id, ready.nostr.getRelayStatus(c.relays)),
                  )
                }
              }
            },
            cancel() {
              if (activeCtl) sseHub.remove(activeCtl)
            },
          })
          // req.signal aborts on client disconnect; without this the
          // controller leaks into sseHub forever and every broadcast
          // tries to enqueue into a dead stream.
          req.signal.addEventListener('abort', () => {
            if (activeCtl) {
              sseHub.remove(activeCtl)
              try {
                activeCtl.close()
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
