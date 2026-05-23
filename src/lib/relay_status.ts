import { html, type RawHtml } from './html'

export interface RelayStatus {
  url: string
  connected: boolean
}

/**
 * One-line summary used in list views: "● Relays: 2/2 connected".
 * The count is the load-bearing signal — color and icon are redundant
 * channels so the badge stays readable for color-blind operators.
 */
export function renderRelaySummary(relays: RelayStatus[]): RawHtml {
  if (relays.length === 0) {
    return html`<span class="relay-pill down">○ No relays configured</span>`
  }
  const ok = relays.filter((r) => r.connected).length
  const total = relays.length
  const cls = ok === total ? 'ok' : ok === 0 ? 'down' : 'partial'
  const icon = ok === total ? '●' : ok === 0 ? '○' : '◐'
  const label = ok === total ? 'all connected' : ok === 0 ? 'all offline' : 'partial'
  return html`<span class="relay-pill ${cls}">${icon} Relays: ${ok}/${total} ${label}</span>`
}

/**
 * Detail table rows used on the connection page. Returns the rows only
 * (no surrounding table) so the table element can stay in the view
 * template and SSE updates can just swap the rows' innerHTML.
 */
export function renderRelayDetail(relays: RelayStatus[]): RawHtml {
  if (relays.length === 0) {
    return html`<tr><td colspan="2" class="muted">No relays configured for this connection.</td></tr>`
  }
  return html`${relays.map(
    (r) => html`
      <tr>
        <td><code>${r.url}</code></td>
        <td>
          ${r.connected
            ? html`<span class="relay-pill ok">● Connected</span>`
            : html`<span class="relay-pill down">○ Offline</span>`}
        </td>
      </tr>
    `,
  )}`
}

export function relayStatusPayload(relays: RelayStatus[]): {
  summaryHtml: string
  detailHtml: string
} {
  return {
    summaryHtml: renderRelaySummary(relays).value,
    detailHtml: renderRelayDetail(relays).value,
  }
}
