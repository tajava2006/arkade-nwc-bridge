import { html, type RawHtml } from './html'
import type { OutboxSource } from '../nostr/outbox'

export interface RelayStatus {
  url: string
  connected: boolean
}

/**
 * Small badge — "2/3 ● connected" — used on the connections list row
 * and inline anywhere a one-line relay summary fits. Both the count
 * and the icon are load-bearing so the badge stays legible without
 * color (red/green distinction is unreliable for color-blind operators).
 */
export function renderRelayBadge(relays: RelayStatus[]): RawHtml {
  if (relays.length === 0) {
    return html`<span class="relay-pill down">○ no relays</span>`
  }
  const ok = relays.filter((r) => r.connected).length
  const total = relays.length
  const cls = ok === total ? 'ok' : ok === 0 ? 'down' : 'partial'
  const icon = ok === total ? '●' : ok === 0 ? '○' : '◐'
  return html`<span class="relay-pill ${cls}">${icon} ${ok}/${total}</span>`
}

/**
 * Per-relay rows for the connection detail page. Returns only the
 * <tr> elements so the outer <table> stays in the template and SSE
 * pushes can just swap innerHTML of the wrapping <tbody>.
 */
export function renderRelayDetail(relays: RelayStatus[]): RawHtml {
  if (relays.length === 0) {
    return html`<tr><td colspan="2" class="muted">This connection has no relays — it can't receive any requests.</td></tr>`
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

/**
 * Top panel on the connections list page. Two stacked sections:
 *   - Bootstrap relays (informational — only used to discover the
 *     outbox; here so the operator can see when the hardcoded list
 *     needs refreshing)
 *   - Outbox relays (the default relays new connections will get),
 *     labelled with where they came from (the account key's own 10002,
 *     the operator's, or the static last-resort set)
 * Each row is one relay with status.
 */
export function renderOutboxPanel(args: {
  bootstrap: RelayStatus[]
  outbox: RelayStatus[]
  outboxSource: OutboxSource
}): RawHtml {
  const bootstrapBadge = renderRelayBadge(args.bootstrap)
  const outboxBadge = renderRelayBadge(args.outbox)
  return html`
    <div class="relay-panel">
      <div class="relay-panel-row">
        <span class="relay-panel-label">
          Bootstrap relays
          <span class="muted">(outbox discovery)</span>
        </span>
        ${bootstrapBadge}
      </div>
      ${renderRelayList(args.bootstrap)}
      <div class="relay-panel-row">
        <span class="relay-panel-label">
          New connections will use
          <span class="muted">(${outboxSourceLabel(args.outboxSource)})</span>
        </span>
        ${outboxBadge}
      </div>
      ${renderRelayList(args.outbox)}
    </div>
  `
}

function outboxSourceLabel(source: OutboxSource): string {
  switch (source) {
    case 'user':
      return 'your relays'
    case 'operator':
      return 'operator relays'
    case 'fallback':
      return 'unresolved — default fallback'
  }
}

function renderRelayList(relays: RelayStatus[]): RawHtml {
  if (relays.length === 0) return html`<p class="muted relay-panel-list">(none)</p>`
  return html`
    <ul class="relay-panel-list">
      ${relays.map(
        (r) => html`
          <li>
            ${r.connected
              ? html`<span class="relay-dot ok">●</span>`
              : html`<span class="relay-dot down">○</span>`}
            <code>${r.url}</code>
          </li>
        `,
      )}
    </ul>
  `
}

export function outboxPanelPayload(args: {
  bootstrap: RelayStatus[]
  outbox: RelayStatus[]
  outboxSource: OutboxSource
}): { html: string } {
  return { html: renderOutboxPanel(args).value }
}

export function connectionRelayPayload(
  connectionId: number,
  relays: RelayStatus[],
): { connectionId: number; summaryHtml: string; detailHtml: string } {
  return {
    connectionId,
    summaryHtml: renderRelayBadge(relays).value,
    detailHtml: renderRelayDetail(relays).value,
  }
}
