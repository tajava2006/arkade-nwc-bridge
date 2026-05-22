import { html, type RawHtml } from '../../lib/html'
import { layout } from './layout'
import type { Connection } from '../../nostr/connections'

function formatBudget(c: Connection): string {
  if (c.budgetMsat === null) return '∞'
  const sats = Math.floor(c.budgetMsat / 1000)
  const spentSats = Math.floor(c.spentMsat / 1000)
  return `${spentSats.toLocaleString()} / ${sats.toLocaleString()} sats`
}

function formatSpent(c: Connection): string {
  return `${Math.floor(c.spentMsat / 1000).toLocaleString()} sats`
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString()
}

export function connectionsListView(args: {
  active: Connection[]
  revoked: Connection[]
}): RawHtml {
  const renderActive = (c: Connection) => html`
    <tr>
      <td>#${c.id}</td>
      <td>${c.label ?? html`<span class="muted">(no label)</span>`}</td>
      <td class="muted">${formatDate(c.createdAt)}</td>
      <td class="num">${c.budgetMsat === null ? formatSpent(c) : formatBudget(c)}</td>
      <td>
        <form action="/connections/${c.id}/revoke" method="post" style="display:inline; margin:0">
          <button type="submit" class="danger" onclick="return confirm('Revoke connection #${c.id}? The NWC client will stop working.')">Revoke</button>
        </form>
      </td>
    </tr>
  `
  const renderRevoked = (c: Connection) => html`
    <tr>
      <td class="muted">#${c.id}</td>
      <td class="muted">${c.label ?? '(no label)'}</td>
      <td class="muted">${formatDate(c.createdAt)} → ${c.revokedAt ? formatDate(c.revokedAt) : '?'}</td>
      <td class="num muted">${formatSpent(c)}</td>
      <td></td>
    </tr>
  `

  return layout({
    title: 'Connections',
    current: 'connections',
    body: html`
      <p><a href="/connections/new">+ New connection</a></p>

      <h2>Active</h2>
      ${args.active.length === 0
        ? html`<p class="muted">No active connections yet. <a href="/connections/new">Create one</a> to start using NWC.</p>`
        : html`
            <table>
              <tr><th>ID</th><th>Label</th><th>Created</th><th class="num">Spent / Budget</th><th></th></tr>
              ${args.active.map(renderActive)}
            </table>
          `}

      ${args.revoked.length > 0
        ? html`
            <h2>Revoked</h2>
            <table>
              <tr><th>ID</th><th>Label</th><th>Lifetime</th><th class="num">Spent</th><th></th></tr>
              ${args.revoked.map(renderRevoked)}
            </table>
          `
        : null}
    `,
  })
}
