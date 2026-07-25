import { html, type RawHtml } from '../../lib/html'
import { formatHistoryCursor, type HistoryPage, type HistoryRow } from '../../history'
import { layout } from './layout'
import { copyable, localTime } from './ui'

// Unified wallet history (HISTORY_DESIGN.md): every rail, newest first,
// keyset-paginated strictly forward ("Older" only — no offsets, no counts).

const KIND_LABEL: Record<HistoryRow['kind'], string> = {
  nwc_ln: 'NWC · LN',
  web_ln: 'Web · LN',
  noffer: 'noffer / zap',
  ark_send: 'Ark',
  onboard: 'Onchain in',
  offboard: 'Onchain out',
}

// amount_msat is a whole-sat multiple everywhere today, but render sub-sat
// remainders honestly if a future rail introduces them.
function fmtMsatAsSats(msat: number): string {
  const sats = msat / 1000
  return `${sats.toLocaleString(undefined, { maximumFractionDigits: 3 })} sats`
}

function stateClass(state: HistoryRow['state']): string {
  switch (state) {
    case 'settled':
      return 'settled'
    case 'pending':
      return 'pending'
    case 'expired':
      return 'preconfirmed'
    default:
      return 'failed'
  }
}

function detailCell(row: HistoryRow): RawHtml {
  const parts: RawHtml[] = []
  if (row.description) {
    const short = row.description.length > 80 ? `${row.description.slice(0, 80)}…` : row.description
    parts.push(html`<div>${short}</div>`)
  }
  if (row.txid) {
    parts.push(html`<div class="muted">tx ${copyable(row.txid, `${row.txid.slice(0, 12)}…`)}</div>`)
  }
  if (row.txid2) {
    parts.push(html`<div class="muted">settled by ${copyable(row.txid2, `${row.txid2.slice(0, 12)}…`)}</div>`)
  }
  if (row.error) {
    const short = row.error.length > 120 ? `${row.error.slice(0, 120)}…` : row.error
    parts.push(html`<div class="bad" style="font-weight: normal; font-size: 0.85em">${short}</div>`)
  }
  return html`${parts}`
}

export function historyView(args: { page: HistoryPage; isFirstPage: boolean }): RawHtml {
  const { page, isFirstPage } = args

  const rows = page.rows.map((row) => {
    const sign = row.direction === 'in' ? '+' : '−'
    const muted = row.state === 'expired' || row.state === 'failed'
    return html`<tr class="${muted ? 'dim' : ''}">
      <td>${localTime(row.created_at * 1000)}</td>
      <td>${KIND_LABEL[row.kind] ?? row.kind}</td>
      <td class="num">${sign}${fmtMsatAsSats(row.amount_msat)}</td>
      <td class="num">${row.fees_msat !== null && row.fees_msat > 0 ? fmtMsatAsSats(row.fees_msat) : '—'}</td>
      <td><span class="pill ${stateClass(row.state)}">${row.state}</span></td>
      <td>${detailCell(row)}</td>
    </tr>`
  })

  const pager = html`<p>
    ${isFirstPage ? html`` : html`<a href="/history">« Latest</a> `}
    ${page.next ? html`<a href="/history?before=${formatHistoryCursor(page.next)}">Older »</a>` : html``}
  </p>`

  const body = html`
    <p class="muted">
      Every rail the bridge executes or observes: NWC & web Lightning, noffer/zap
      receives, Ark offchain sends, onchain deposits (boarding) and offboards.
      Newest first. Amounts are the nominal; fees are the bridge's cost on top.
    </p>
    ${page.rows.length === 0
      ? html`<p>${isFirstPage ? 'No activity recorded yet.' : 'No older entries.'}</p>`
      : html`<table>
          <thead>
            <tr><th>Time</th><th>Kind</th><th class="num">Amount</th><th class="num">Fee</th><th>Status</th><th>Detail</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`}
    ${pager}
  `
  return layout({ title: 'History', current: 'history', body })
}
