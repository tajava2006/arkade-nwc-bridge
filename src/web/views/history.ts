import { html, type RawHtml } from '../../lib/html'
import { layout } from './layout'

export interface HistoryRow {
  type: 'incoming' | 'outgoing'
  state: string
  amount_msat: number
  fees_paid_msat: number | null
  description: string | null
  payment_hash: string
  created_at: number
  settled_at: number | null
}

function statePill(state: string): RawHtml {
  const cls =
    state === 'settled' ? 'settled' : state === 'failed' ? 'failed' : 'pending'
  return html`<span class="pill ${cls}">${state}</span>`
}

export function historyView(rows: HistoryRow[]): RawHtml {
  return layout({
    title: 'History',
    current: 'history',
    body: rows.length === 0
      ? html`<p class="muted">No transactions yet.</p>`
      : html`
          <table>
            <tr>
              <th>When</th>
              <th></th>
              <th class="num">Amount</th>
              <th class="num">Fee</th>
              <th>State</th>
              <th>Description</th>
            </tr>
            ${rows.map((r) => html`
              <tr>
                <td class="muted">${new Date(r.created_at * 1000).toLocaleString()}</td>
                <td>${r.type === 'incoming' ? '↓' : '↑'}</td>
                <td class="num">${Math.floor(r.amount_msat / 1000).toLocaleString()} sats</td>
                <td class="num">${r.fees_paid_msat == null ? '-' : Math.floor(r.fees_paid_msat / 1000).toLocaleString() + ' sats'}</td>
                <td>${statePill(r.state)}</td>
                <td>${r.description ?? html`<span class="muted">${r.payment_hash.slice(0, 12)}…</span>`}</td>
              </tr>
            `)}
          </table>
        `,
  })
}
