import { html, raw, type RawHtml } from '../../lib/html'
import { layout } from './layout'

export function newConnectionForm(args?: { error?: string; label?: string; budgetSats?: string }): RawHtml {
  return layout({
    title: 'New connection',
    current: 'connections',
    body: html`
      ${args?.error ? html`<p style="color:#c00">${args.error}</p>` : null}
      <form action="/connections/new" method="post">
        <label>
          Label (optional)
          <input type="text" name="label" maxlength="80" placeholder="e.g. amethyst on phone" value="${args?.label ?? ''}" />
        </label>
        <label>
          Budget in sats (optional, leave empty for unlimited)
          <input type="number" name="budget_sats" min="0" placeholder="" value="${args?.budgetSats ?? ''}" />
        </label>
        <button type="submit">Create</button>
      </form>
    `,
  })
}

export function newConnectionResultView(args: {
  connectionId: number
  uri: string
  qrSvg: string
}): RawHtml {
  return layout({
    title: 'Connection created',
    current: 'connections',
    body: html`
      <p>Connection #${args.connectionId} created. <a href="/connections">Back to list</a></p>

      <h2>NWC URI</h2>
      <p class="muted">Paste this into your nostr client. The client secret is embedded in the URI and is <strong>not</strong> stored on this server — save it now, or re-issue a new connection later.</p>
      <pre>${args.uri}</pre>

      <h2>QR</h2>
      <div class="qr-box">${raw(args.qrSvg)}</div>
    `,
  })
}
