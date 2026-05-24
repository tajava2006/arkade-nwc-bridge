import { html, type RawHtml } from '../../lib/html'
import { layout } from './layout'
import type { Connection } from '../../nostr/connections'
import type { TransactionRow } from '../../lib/transaction'
import { renderRelayDetail, type RelayStatus } from '../../lib/relay_status'

function statePill(state: string): RawHtml {
  const cls = state === 'settled' ? 'settled' : state === 'failed' ? 'failed' : 'pending'
  return html`<span class="pill ${cls}">${state}</span>`
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString()
}

function formatBudget(c: Connection): string {
  if (c.budgetMsat === null) return '∞ (unlimited)'
  const sats = Math.floor(c.budgetMsat / 1000)
  const spentSats = Math.floor(c.spentMsat / 1000)
  return `${spentSats.toLocaleString()} / ${sats.toLocaleString()} sats`
}

export function connectionDetailView(args: {
  conn: Connection
  transactions: TransactionRow[]
  relays: RelayStatus[]
}): RawHtml {
  const { conn, transactions, relays } = args
  const isRevoked = conn.revokedAt !== null

  return layout({
    title: `Connection #${conn.id}${conn.label ? ` — ${conn.label}` : ''}`,
    current: 'connections',
    body: html`
      <p><a href="/connections">← Back to connections</a></p>

      <h2>Details</h2>
      <table>
        <tr><th>Label</th><td>${conn.label ?? html`<span class="muted">(no label)</span>`}</td></tr>
        <tr><th>State</th><td>${isRevoked
          ? html`<span class="pill failed">revoked at ${formatDate(conn.revokedAt!)}</span>`
          : html`<span class="pill settled">active</span>`}</td></tr>
        <tr><th>Created</th><td class="muted">${formatDate(conn.createdAt)}</td></tr>
        <tr><th>Spent / budget</th><td>${formatBudget(conn)}</td></tr>
        <tr><th>Service pubkey</th><td><code>${conn.servicePubkeyHex}</code></td></tr>
        <tr><th>Client pubkey</th><td><code>${conn.clientPubkeyHex}</code></td></tr>
      </table>

      <h2>Relays</h2>
      <p class="muted">
        Relays this connection uses for NWC traffic. The list is fixed at
        creation time — to change it, revoke the connection and create a
        new one.
      </p>
      <table>
        <tbody data-connection-relay-detail="${conn.id}">
          ${renderRelayDetail(relays)}
        </tbody>
      </table>

      <h2>NWC transactions</h2>
      ${transactions.length === 0
        ? html`<p class="muted">No NWC activity on this connection yet.</p>`
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
              ${transactions.map((r) => html`
                <tr>
                  <td class="muted">${formatDate(r.created_at)}</td>
                  <td>${r.type === 'incoming' ? '↓' : '↑'}</td>
                  <td class="num">${Math.floor(r.amount_msat / 1000).toLocaleString()} sats</td>
                  <td class="num">${r.fees_paid_msat == null ? '-' : Math.floor(r.fees_paid_msat / 1000).toLocaleString() + ' sats'}</td>
                  <td>${statePill(r.state)}</td>
                  <td>${r.description ?? (r.error ? html`<span class="muted">${r.error}</span>` : html`<span class="muted">${r.payment_hash.slice(0, 12)}…</span>`)}</td>
                </tr>
              `)}
            </table>
          `}
    `,
  })
}
