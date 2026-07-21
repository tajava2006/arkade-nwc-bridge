import { html, type RawHtml } from '../../lib/html'
import { layout } from './layout'
import { localTime } from './ui'
import type { Connection } from '../../nostr/connections'
import {
  renderOutboxPanel,
  renderRelayBadge,
  type RelayStatus,
} from '../../lib/relay_status'
import type { OutboxSource } from '../../nostr/outbox'

function formatBudget(c: Connection, spentNowMsat: number): string {
  const spentSats = Math.floor(spentNowMsat / 1000)
  if (c.budgetMsat === null) return `${spentSats.toLocaleString()} sats`
  const sats = Math.floor(c.budgetMsat / 1000)
  const base = `${spentSats.toLocaleString()} / ${sats.toLocaleString()} sats`
  return c.budgetRenewal === 'never' ? base : `${base} · ${c.budgetRenewal}`
}

// Revoked rows show the lifetime counter — "what this connection spent in
// total", not the current window it can no longer spend in.
function formatSpent(c: Connection): string {
  return `${Math.floor(c.spentMsat / 1000).toLocaleString()} sats`
}

function formatDate(unix: number): RawHtml {
  return localTime(unix * 1000)
}

export function connectionsListView(args: {
  active: Connection[]
  revoked: Connection[]
  /** Live status of each active connection's relays, keyed by connection id. */
  connectionStatuses: Map<number, RelayStatus[]>
  /** Current-window spend per active connection (lib/budget cycleSpentMsat). */
  spentNowMsat: Map<number, number>
  outboxPanel: {
    bootstrap: RelayStatus[]
    outbox: RelayStatus[]
    outboxSource: OutboxSource
  }
}): RawHtml {
  const renderActive = (c: Connection) => {
    const status = args.connectionStatuses.get(c.id) ?? []
    return html`
      <tr>
        <td><a href="/connections/${c.id}">#${c.id}</a></td>
        <td>${c.label ?? html`<span class="muted">(no label)</span>`}</td>
        <td class="muted">${formatDate(c.createdAt)}</td>
        <td class="num">${formatBudget(c, args.spentNowMsat.get(c.id) ?? 0)}</td>
        <td><span data-connection-relay-summary="${c.id}">${renderRelayBadge(status)}</span></td>
        <td>
          <form action="/connections/${c.id}/revoke" method="post" style="display:inline; margin:0">
            <button type="submit" class="danger" onclick="return confirm('Revoke connection #${c.id}? The NWC client will stop working.')">Revoke</button>
          </form>
        </td>
      </tr>
    `
  }
  const renderRevoked = (c: Connection) => html`
    <tr>
      <td class="muted"><a href="/connections/${c.id}">#${c.id}</a></td>
      <td class="muted">${c.label ?? '(no label)'}</td>
      <td class="muted">${formatDate(c.createdAt)} → ${c.revokedAt ? formatDate(c.revokedAt) : '?'}</td>
      <td class="num muted">${formatSpent(c)}</td>
      <td></td>
      <td></td>
    </tr>
  `

  return layout({
    title: 'Connections',
    current: 'connections',
    body: html`
      <div data-outbox-panel>${renderOutboxPanel(args.outboxPanel)}</div>

      <p><a href="/connections/new">+ New connection</a></p>

      <h2>Active</h2>
      ${args.active.length === 0
        ? html`<p class="muted">No active connections yet. <a href="/connections/new">Create one</a> to start using NWC.</p>`
        : html`
            <table>
              <tr><th>ID</th><th>Label</th><th>Created</th><th class="num">Spent / Budget</th><th>Relays</th><th></th></tr>
              ${args.active.map(renderActive)}
            </table>
          `}

      ${args.revoked.length > 0
        ? html`
            <h2>Revoked</h2>
            <table>
              <tr><th>ID</th><th>Label</th><th>Lifetime</th><th class="num">Spent</th><th>Relays</th><th></th></tr>
              ${args.revoked.map(renderRevoked)}
            </table>
          `
        : null}
    `,
  })
}
