import { html, type RawHtml } from '../../lib/html'
import { layout } from './layout'
import { copyable, localTime } from './ui'
import type { AtomicSwapRow } from '../../atomic'
import { isTerminal } from '../../atomic'
import type { Swap } from '@arkade-os/swap'

// Swap monitor: atomic swaps on subdustd (every receive, sub-dust sends —
// ATOMIC_SUBDUST_PLAN.md #13) and dust-and-up sends through our solver. Swaps
// are initiated over NWC/CLINK or /send, not here — this page is for watching
// in-flight ones and pulling the manual refund lever on an atomic send whose
// T has passed (solver sends refund themselves: the swap client's drive).
// Server-rendered snapshot; reload to refresh (swaps are seconds-to-minutes
// affairs, a live ticker isn't worth the machinery).

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id
}

// swap ids are server-issued (not txids), so they're never chain-lookup targets;
// still click-to-copy for parity, since operators do paste them into logs.
function swapIdCell(id: string): RawHtml {
  const short = shortId(id)
  return short === id ? html`<code>${id}</code>` : copyable(id, short)
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
 * blocktime lag). RECEIVE rows store 0 (T is subdustd's) → "— (subdustd)", never a
 * garbage countdown. Terminal rows (claimed/refunded/failed) → "—": the
 * refund clock is moot once the swap resolved, and a stale "Nd ago" on a
 * claimed row reads like something still needs doing.
 */
function refundTCell(s: AtomicSwapRow, nowSec: number): RawHtml {
  if (s.direction !== 'send' || s.refundLocktime <= 0) {
    return html`<span class="muted" title="receive 환불은 subdustd 관리 — bridge측 T 없음">— (subdustd)</span>`
  }
  if (isTerminal(s.direction, s.state)) {
    return html`<span class="muted" title="종결된 스왑 — 환불 시계 해당 없음">—</span>`
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
  // 'cancelled' is a cooperative unwind: the full funding came back early, so
  // it reads green like a refund — the swap failed, the money did not.
  const good =
    s.state === 'claimed' || s.state === 'settled' || s.state === 'refunded' || s.state === 'cancelled'
  const color = terminal ? (good ? '#080' : '#c00') : '#b60'
  return html`<span style="color: ${color}; font-weight: ${terminal ? 'normal' : '600'}">${s.state}</span>`
}

// Dust-and-up sends through our solver. The swap client's drive claims
// nothing here (the solver claims with the preimage) and refunds a failed one
// by itself — through our emulator at once, or after the timelock — so the
// table is read-only. Outcome vocabulary is the client's.
const SOLVER_GOOD = new Set(['paid', 'refunded'])
const SOLVER_DONE = new Set(['paid', 'refunded', 'failed', 'cancelled', 'lapsed'])

function solverBadge(s: Swap): RawHtml {
  const done = SOLVER_DONE.has(s.outcome)
  // refunded is green like a refund elsewhere on this page: the payment
  // failed, the money did not.
  const color = !done ? '#b60' : SOLVER_GOOD.has(s.outcome) ? '#080' : '#c00'
  return html`<span style="color: ${color}; font-weight: ${done ? 'normal' : '600'}" title="${s.failure ?? s.blockedReason ?? ''}">${s.outcome}</span>`
}

const solverRow = (s: Swap) => html`
  <tr>
    <td>${swapIdCell(s.id)}</td>
    <td>${solverBadge(s)}</td>
    <td class="num">${Number(s.take.amount).toLocaleString()} sats</td>
    <td class="num">${(Number(s.give.amount) - Number(s.take.amount)).toLocaleString()} sats</td>
    <td class="muted">${s.fundingTxid ? copyable(s.fundingTxid, `${s.fundingTxid.slice(0, 12)}…`) : '—'}</td>
    <td class="muted">${localTime(s.createdAt * 1000)}</td>
  </tr>
`

function solverTable(swaps: Swap[]): RawHtml {
  return swaps.length === 0
    ? html`<p class="muted">No solver sends yet.</p>`
    : html`<table>
        <tr>
          <th>swap</th><th>outcome</th><th class="num">invoice</th><th class="num">fee</th><th>funding</th><th>created</th>
        </tr>
        ${[...swaps].sort((a, b) => b.createdAt - a.createdAt).map(solverRow)}
      </table>`
}

export function swapsView(args: {
  swaps: AtomicSwapRow[]
  solverSends: Swap[]
  nowSec: number
  notice?: { ok: boolean; text: string }
}): RawHtml {
  const { swaps, nowSec } = args
  const inflight = swaps.filter((s) => !isTerminal(s.direction, s.state))
  const done = swaps.filter((s) => isTerminal(s.direction, s.state))

  const row = (s: AtomicSwapRow) => html`
    <tr>
      <td>${swapIdCell(s.id)}</td>
      <td>${s.direction}</td>
      <td>${stateBadge(s)}</td>
      <td class="num">${s.amount.toLocaleString()} sats</td>
      <td>${refundTCell(s, nowSec)}</td>
      <td class="muted">${s.fundingOutpoint ? copyable(s.fundingOutpoint, `${s.fundingOutpoint.slice(0, 12)}…`) : '—'}</td>
      <td class="muted">${localTime(s.createdAt)}</td>
      <td>
        ${refundable(s, nowSec)
          ? html`<form method="post" action="/swaps/refund" style="max-width:none">
              <input type="hidden" name="swapId" value="${s.id}" />
              <button class="danger" title="Reclaim the full funding through the refund leaf (T has passed — subdustd not needed)">Refund</button>
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
    ${args.notice
      ? html`<p style="color: ${args.notice.ok ? '#080' : '#c00'}">${args.notice.text}</p>`
      : html``}

    <h2>Atomic swaps <span class="muted">(subdustd, custom, beta)</span></h2>
    <p class="muted">
      Every Lightning receive, and sends below dust, ride a shared 4-leaf vtxo — a custom, beta
      protocol built for this bridge, served by the operator's subdustd. In-flight <em>send</em>
      funding is mirrored into the exit vault (visible on the Exit tab) until the swap resolves; if
      subdustd never pays, the full funding is reclaimable here once T passes.
    </p>
    <h3>In flight (${inflight.length})</h3>
    ${table(inflight, 'No swaps in flight.')}
    <h3>Recent</h3>
    ${table(done, 'No completed swaps yet.')}

    <h2>Solver sends</h2>
    <p class="muted">
      Lightning sends of dust and up, through the operator's own intent solver. The solver can take
      the lockup only with the payment's preimage; a failed payment comes back by itself. Read-only.
    </p>
    ${solverTable(args.solverSends)}
  `
  return layout({ title: 'Swaps', current: 'swaps', body })
}
