import { html, type RawHtml } from '../../lib/html'
import { layout } from './layout'
import type { AtomicSwapRow } from '../../atomic'
import { isTerminal } from '../../atomic'

// Atomic sub-dust swap monitor (ATOMIC_SUBDUST_PLAN.md #13). Swaps are
// initiated over NWC/CLINK, not here — this page is for watching in-flight
// ones and pulling the manual refund lever on a send whose T has passed.
// Server-rendered snapshot; reload to refresh (swaps are seconds-to-minutes
// affairs, a live ticker isn't worth the machinery).

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id
}

function formatDate(unixMs: number): string {
  return new Date(unixMs).toLocaleString()
}

// arkd enforces the CLTV against BLOCKTIME (MTP), which lags wall clocks by
// ~1h on mainnet (median-time-past ≈ the 6th-back block). A refund fired at
// wall-clock T bounces with FORFEIT_CLOSURE_LOCKED until blocktime passes T.
// So the button + countdown target T + this margin, not raw T — otherwise the
// lever looks live ~1h before arkd will actually accept it. Heuristic (real
// lag varies); an early click still fails gracefully (RefundNotYetError) and
// the boot/tick executor retries regardless.
const BLOCKTIME_LAG_SEC = 3600

/** When a send's refund can realistically land (blocktime ≥ T), in wall-clock secs. */
function refundReadyAt(s: AtomicSwapRow): number {
  return s.refundLocktime + BLOCKTIME_LAG_SEC
}

/**
 * The refund-T cell = countdown to when the refund can actually land (T + the
 * blocktime lag). RECEIVE rows store 0 (T is boltz's) → "— (boltz)", never a
 * garbage countdown.
 */
function refundTCell(s: AtomicSwapRow, nowSec: number): RawHtml {
  if (s.direction !== 'send' || s.refundLocktime <= 0) {
    return html`<span class="muted" title="receive 환불은 boltz 관리 — bridge측 T 없음">— (boltz)</span>`
  }
  const delta = refundReadyAt(s) - nowSec
  const abs = Math.abs(delta)
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const sec = abs % 60
  const span = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`
  const text = delta >= 0 ? `in ${span}` : `${span} ago`
  const tip = `T = ${new Date(s.refundLocktime * 1000).toLocaleString()} · arkd는 blocktime(MTP, ~1h 지연) 기준이라 그 뒤에야 회수 가능`
  return html`<span title="${tip}">${text}</span>`
}

/**
 * A send swap is manually refundable when it's non-terminal past `init`
 * (something was funded) and the refund can realistically land — i.e. blocktime
 * has (heuristically) passed T. Gating on T + the blocktime lag, not raw T,
 * keeps the button from lighting up ~1h before arkd will accept the spend.
 */
function refundable(s: AtomicSwapRow, nowSec: number): boolean {
  return (
    s.direction === 'send' &&
    ['funded', 'ln_inflight', 'refund_wait'].includes(s.state) &&
    s.fundingOutpoint !== undefined &&
    nowSec >= refundReadyAt(s)
  )
}

function stateBadge(s: AtomicSwapRow): RawHtml {
  const terminal = isTerminal(s.direction, s.state)
  const good = s.state === 'claimed' || s.state === 'settled' || s.state === 'refunded'
  const color = terminal ? (good ? '#080' : '#c00') : '#b60'
  return html`<span style="color: ${color}; font-weight: ${terminal ? 'normal' : '600'}">${s.state}</span>`
}

export function swapsView(args: {
  swaps: AtomicSwapRow[]
  nowSec: number
  notice?: { ok: boolean; text: string }
}): RawHtml {
  const { swaps, nowSec } = args
  const inflight = swaps.filter((s) => !isTerminal(s.direction, s.state))
  const done = swaps.filter((s) => isTerminal(s.direction, s.state))

  const row = (s: AtomicSwapRow) => html`
    <tr>
      <td title="${s.id}">${shortId(s.id)}</td>
      <td>${s.direction}</td>
      <td>${stateBadge(s)}</td>
      <td class="num">${s.amount.toLocaleString()} sats</td>
      <td>${refundTCell(s, nowSec)}</td>
      <td class="muted">${s.fundingOutpoint ? html`<code>${s.fundingOutpoint.slice(0, 12)}…</code>` : '—'}</td>
      <td class="muted">${formatDate(s.createdAt)}</td>
      <td>
        ${refundable(s, nowSec)
          ? html`<form method="post" action="/swaps/refund" style="max-width:none">
              <input type="hidden" name="swapId" value="${s.id}" />
              <button class="danger" title="Reclaim the full funding through the refund leaf (T has passed — no boltz needed)">Refund</button>
            </form>`
          : html``}
      </td>
    </tr>
  `

  const table = (rows: AtomicSwapRow[], empty: string) =>
    rows.length === 0
      ? html`<p class="muted">${empty}</p>`
      : html`<table>
          <tr>
            <th>swap</th><th>dir</th><th>state</th><th class="num">amount</th>
            <th>refund T</th><th>funding</th><th>created</th><th></th>
          </tr>
          ${rows.map(row)}
        </table>`

  const body = html`
    <h1>Atomic swaps</h1>
    ${args.notice
      ? html`<p style="color: ${args.notice.ok ? '#080' : '#c00'}">${args.notice.text}</p>`
      : html``}
    <p class="muted">
      Sub-dust Lightning swaps ride a shared 4-leaf vtxo. In-flight <em>send</em> funding is
      mirrored into the exit vault (visible on the Exit tab) until the swap resolves; if boltz
      never pays, the full funding is reclaimable here once T passes.
    </p>
    <h2>In flight (${inflight.length})</h2>
    ${table(inflight, 'No swaps in flight.')}
    <h2>Recent</h2>
    ${table(done, 'No completed swaps yet.')}
  `
  return layout({ title: 'Atomic swaps', current: 'swaps', body })
}
