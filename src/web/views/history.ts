import type { ArkTransaction } from '@arkade-os/sdk'
import { html, type RawHtml } from '../../lib/html'
import { layout } from './layout'

function shortTxid(key: ArkTransaction['key']): string {
  // Pick whichever of the three is populated. boarding takes precedence
  // since onboarding is the most distinctive event; otherwise the ark txid
  // identifies an offchain send/receive; commitment falls back for batch
  // settlements with no separate ark txid.
  const id = key.boardingTxid || key.arkTxid || key.commitmentTxid || ''
  return id ? `${id.slice(0, 8)}…${id.slice(-6)}` : '-'
}

function txKind(key: ArkTransaction['key']): string {
  if (key.boardingTxid) return 'boarding'
  if (key.arkTxid) return 'ark'
  if (key.commitmentTxid) return 'commitment'
  return '?'
}

/**
 * Inner content of the history list — everything below the explanatory
 * paragraph. Exported so the SSE channel can swap just this region into
 * [data-history] when a fresh wallet.getTransactionHistory() lands.
 * `null` = cache empty, fetch in flight.
 */
export function renderHistoryFragment(txs: ArkTransaction[] | null): RawHtml {
  if (txs === null) {
    return html`<p class="muted">Loading transactions…</p>`
  }
  if (txs.length === 0) {
    return html`<p class="muted">No transactions yet.</p>`
  }
  return html`
    <table>
      <tr>
        <th>When</th>
        <th></th>
        <th class="num">Amount</th>
        <th>Kind</th>
        <th>State</th>
        <th>Txid</th>
      </tr>
      ${txs.map((tx) => html`
        <tr>
          <td class="muted">${new Date(tx.createdAt).toLocaleString()}</td>
          <td>${tx.type === 'RECEIVED' ? '↓' : '↑'}</td>
          <td class="num">${tx.amount.toLocaleString()} sats</td>
          <td class="muted">${txKind(tx.key)}</td>
          <td><span class="pill ${tx.settled ? 'settled' : 'preconfirmed'}">${tx.settled ? 'settled' : 'preconfirmed'}</span></td>
          <td class="muted" title="${tx.key.boardingTxid || tx.key.arkTxid || tx.key.commitmentTxid}">${shortTxid(tx.key)}</td>
        </tr>
      `)}
    </table>
  `
}

export function walletHistoryView(txs: ArkTransaction[] | null): RawHtml {
  return layout({
    title: 'Wallet history',
    current: 'history',
    body: html`
      <p class="muted">
        Raw transaction stream from the Ark wallet — boarding, ark sends/receives, and batch
        commitments. This view doesn't distinguish NWC activity from anything else; for the
        NWC-side log scoped to a particular client, open that connection on the
        <a href="/connections">Connections</a> page.
      </p>
      <div data-history>${renderHistoryFragment(txs)}</div>
    `,
  })
}
