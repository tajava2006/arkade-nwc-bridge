import { html, raw, type RawHtml } from '../../lib/html'
import type { AppState } from '../server'
import type { VaultStats } from '../../exit/vault'
import { qrSvg } from '../qr'
import { layout } from './layout'

type DegradedState = Extract<AppState, { mode: 'degraded' }>

function ago(sec: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec)
  if (d < 90) return `${d}s ago`
  if (d < 5400) return `${Math.floor(d / 60)}m ago`
  return `${Math.floor(d / 3600)}h ago`
}

/**
 * Status page for mode:'degraded' — the ASP/Boltz bring-up failed, which is
 * the scenario unilateral exit exists for. Everything shown here must hold
 * without the ASP: vault stats are local sqlite, the funding address is
 * derived from the nsec. The page reloads itself when the 60s boot retry
 * promotes to ready (mode-change SSE → layout script).
 */
export function degradedView(args: { state: DegradedState; stats: VaultStats }): RawHtml {
  const { state, stats } = args
  const readiness =
    stats.vtxoCount === 0
      ? html`<span class="muted">vault is empty — nothing to exit</span>`
      : stats.readyCount === stats.vtxoCount
        ? html`<span class="ok">${stats.readyCount}/${stats.vtxoCount} vtxos exit-ready offline</span>`
        : html`<span class="bad">${stats.readyCount}/${stats.vtxoCount} vtxos exit-ready</span> —
            proofs for the rest were not fully mirrored before the outage`
  const lastSync =
    stats.lastSyncedAt === null
      ? 'never'
      : ago(stats.lastSyncedAt)
  return layout({
    title: 'Degraded — ASP unreachable',
    current: 'dashboard',
    body: html`
      <div class="relay-panel" style="border-color:#c00;">
        <p>
          <span class="bad">The Ark/Boltz service stack is unreachable.</span>
          Normal operation (NWC, sends, receives) is paused.
        </p>
        <p class="muted">
          Last error: <code>${state.error}</code><br />
          Degraded since ${ago(state.since)} · ${state.attempts} boot attempt(s) ·
          retrying every 60s — this page reloads automatically when service recovers.
        </p>
      </div>

      <h2>Unilateral exit</h2>
      <p>
        ${readiness}
        <span class="muted">· proofs ${(stats.proofBytes / 1024).toFixed(0)} KB · last mirrored ${lastSync}</span>
      </p>
      <p class="muted">
        The pre-signed exit proofs live in this machine's local vault and do not
        need the ASP. <a href="/exit">Open the Exit tab</a> for per-vtxo costs
        and the guided unroll → CSV wait → sweep flow.
      </p>

      <h2>Exit fuel (onchain)</h2>
      <div class="receive-card">
        <div class="qr-box">${raw(qrSvg(state.onchainAddress))}</div>
        <pre>${state.onchainAddress}</pre>
        <p class="muted">
          Unilateral exit broadcasts zero-fee pre-signed transactions, each
          CPFP-bumped from this plain Taproot address (derived from the same
          nsec as the wallet — no extra backup). Fund it with enough sats to
          pay exit fees; it is also the default sweep destination.
        </p>
      </div>
    `,
  })
}
