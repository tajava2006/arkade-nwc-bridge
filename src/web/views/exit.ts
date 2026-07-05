import { html, type RawHtml } from '../../lib/html'
import type { VaultVtxo, VaultStats } from '../../exit/vault'
import type { ExitEstimate } from '../../exit/estimate'
import type { ExitOp } from '../../exit/ops'
import { layout } from './layout'

// The /exit tab (EXIT_PLAN #12): one row per mirrored vtxo, execution
// strictly per-vtxo (§1 — no bulk button, ever). Every number a user needs
// to answer "is pulling this one out worth it" sits in the row: expiry (the
// hard deadline — after the ASP sweeps, proofs are dead), proof
// completeness, and the measured cost of the full unroll+sweep at the
// current fee rate with an explicit losing-money verdict.

export interface ExitRow {
  vtxo: VaultVtxo
  ready: boolean
  estimate: ExitEstimate | null
  op: ExitOp | null
}

function fmtSats(n: number): string {
  return `${n.toLocaleString()} sats`
}

function short(txid: string): string {
  return `${txid.slice(0, 8)}…${txid.slice(-6)}`
}

export function expiryCountdown(expiresAt: number | null, nowSec: number): RawHtml {
  if (expiresAt === null) return html`<span class="muted">unknown</span>`
  const d = expiresAt - nowSec
  if (d <= 0) return html`<span class="bad">EXPIRED — proofs are dead paper</span>`
  const days = Math.floor(d / 86_400)
  const hours = Math.floor((d % 86_400) / 3_600)
  const label = days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((d % 3_600) / 60)}m`
  // under two days the ASP sweep race is uncomfortably near — surface it
  return d < 2 * 86_400
    ? html`<span class="bad">${label} left</span>`
    : html`<span>${label} left</span>`
}

function verdict(row: ExitRow): RawHtml {
  if (row.vtxo.status === 'swept') {
    // §2.7: the ASP already spent the tree root — complete proofs or not,
    // unilateral exit is gone; only a cooperative settlement recovers this
    return html`<span class="pill failed">unilateral exit impossible — cooperative recovery only</span>`
  }
  if (!row.ready) {
    return html`<span class="pill pending">proofs incomplete — cannot exit offline yet</span>`
  }
  if (row.estimate?.uneconomical) {
    return html`<span class="pill failed">exiting loses money (fees ≥ value)</span>`
  }
  return html`<span class="pill settled">exitable</span>`
}

function estimateCell(est: ExitEstimate | null): RawHtml {
  if (!est) return html`<span class="muted">—</span>`
  const pct = Number.isFinite(est.feePctOfValue) ? `${est.feePctOfValue}%` : '∞'
  return html`${est.packages} tx + sweep · ${est.totalVb.toLocaleString()} vB ·
    ~${fmtSats(est.totalFeeSat)} <span class="muted">(${pct} of value)</span>`
}

function opPill(op: ExitOp | null): RawHtml {
  if (!op) return html`<span class="muted">—</span>`
  const cls =
    op.state === 'swept' ? 'settled' : op.state === 'failed' ? 'failed' : 'pending'
  return html`<span class="pill ${cls}" data-exit-op-state>${op.state}</span>`
}

export function renderExitRows(rows: ExitRow[], nowSec: number): RawHtml {
  if (rows.length === 0) {
    return html`<tr><td colspan="6" class="muted">The vault has no mirrored vtxos.</td></tr>`
  }
  return html`${rows.map(
    (row) => html`
      <tr data-exit-row="${row.vtxo.txid}:${row.vtxo.vout}">
        <td><a href="/exit/${row.vtxo.txid}/${row.vtxo.vout}"><code>${short(row.vtxo.txid)}:${row.vtxo.vout}</code></a></td>
        <td class="num">${fmtSats(row.vtxo.valueSat)}</td>
        <td>${expiryCountdown(row.vtxo.expiresAt, nowSec)}</td>
        <td>${estimateCell(row.estimate)}</td>
        <td>${verdict(row)}</td>
        <td>${opPill(row.op)}</td>
      </tr>
    `,
  )}`
}

export function exitView(args: {
  rows: ExitRow[]
  feeRate: number
  degraded: boolean
  stats: VaultStats
  nowSec: number
}): RawHtml {
  const { rows, stats } = args
  return layout({
    title: 'Unilateral exit',
    current: 'exit',
    body: html`
      ${args.degraded
        ? html`<p class="bad">Degraded mode — the ASP is unreachable. Everything on this
            page works from the local vault and esplora only.</p>`
        : html``}
      <p class="muted">
        ${stats.readyCount}/${stats.vtxoCount} vtxos exit-ready · proofs
        ${(stats.proofBytes / 1024).toFixed(0)} KB · fee rate ${args.feeRate} sat/vB ·
        costs are measured from the pre-signed txs, not guessed. Exits run
        <strong>one vtxo at a time</strong> — judge each row before pulling it.
      </p>
      <table>
        <tr>
          <th>vtxo</th>
          <th class="num">value</th>
          <th>expiry (exit deadline)</th>
          <th>exit cost (unroll + sweep)</th>
          <th>verdict</th>
          <th>op</th>
        </tr>
        ${renderExitRows(rows, args.nowSec)}
      </table>
      <p class="muted">
        Expiry is the hard deadline: once the ASP sweeps an expired batch the
        pre-signed proofs are unusable. Deep payment chains cost more to exit —
        settling (refresh) resets the chain and with it the exit price.
      </p>
    `,
  })
}
