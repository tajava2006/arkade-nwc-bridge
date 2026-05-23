import { html, raw, type RawHtml } from '../../lib/html'

const STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 900px; margin: 2em auto; padding: 0 1em; color: #222; line-height: 1.5; }
  nav { display: flex; gap: 1em; border-bottom: 1px solid #ddd; padding-bottom: 0.5em; margin-bottom: 2em; }
  nav a { text-decoration: none; color: #06c; padding: 0.25em 0; }
  nav a.active { font-weight: 600; color: #222; border-bottom: 2px solid #06c; }
  h1 { font-size: 1.6em; margin-top: 0; }
  h2 { font-size: 1.2em; margin-top: 2em; }
  table { width: 100%; border-collapse: collapse; margin-top: 1em; }
  th, td { text-align: left; padding: 0.5em 0.6em; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #f6f6f6; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  button { padding: 0.4em 0.9em; cursor: pointer; font-size: 0.95em; border: 1px solid #ccc; background: white; border-radius: 4px; }
  button.danger { background: #f5f5f5; color: #c00; border-color: #c00; }
  button.danger:hover { background: #c00; color: white; }
  form { display: flex; flex-direction: column; gap: 0.6em; max-width: 420px; }
  form label { display: flex; flex-direction: column; gap: 0.2em; }
  input { padding: 0.5em; font-size: 1em; border: 1px solid #ccc; border-radius: 4px; }
  pre { background: #f6f6f6; padding: 1em; overflow-x: auto; white-space: pre-wrap; word-break: break-all; border-radius: 4px; }
  .muted { color: #888; font-size: 0.9em; }
  .stat { display: inline-block; margin-right: 2.5em; vertical-align: top; }
  .stat-value { font-size: 1.6em; font-weight: 600; }
  .stat-label { color: #888; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.05em; }
  .qr-box { max-width: 280px; background: white; padding: 0.5em; border: 1px solid #ddd; border-radius: 4px; }
  .qr-box svg { width: 100%; height: auto; }
  .pill { display: inline-block; padding: 0.1em 0.5em; border-radius: 999px; font-size: 0.8em; }
  .pill.settled { background: #d4edda; color: #155724; }
  .pill.pending { background: #fff3cd; color: #856404; }
  .pill.preconfirmed { background: #e2e3e5; color: #495057; }
  .pill.failed { background: #f8d7da; color: #721c24; }
  /* Relay status — colors picked from a blue/gray/amber set to avoid red/green
     so the badges stay distinguishable for red-green color blindness. Icon
     and text label are redundant channels: any one of them disambiguates. */
  .relay-bar { margin: 0 0 1em; }
  .relay-pill { display: inline-block; padding: 0.15em 0.65em; border-radius: 999px; font-size: 0.85em; font-weight: 500; }
  .relay-pill.ok { background: #cfe7ff; color: #00345e; }
  .relay-pill.partial { background: #ffe6b3; color: #7a4a00; }
  .relay-pill.down { background: #e3e3e3; color: #444; }
`

type Nav = 'dashboard' | 'connections' | 'history' | 'setup'

export function layout(args: {
  title: string
  current: Nav
  body: RawHtml
}): RawHtml {
  const tab = (key: Nav, href: string, label: string) =>
    html`<a href="${href}" class="${args.current === key ? 'active' : ''}">${label}</a>`
  // Setup mode has no useful nav targets — every other page would just
  // redirect back here — so render bare.
  const nav =
    args.current === 'setup'
      ? html``
      : html`<nav>
          ${tab('dashboard', '/', 'Dashboard')}
          ${tab('connections', '/connections', 'Connections')}
          ${tab('history', '/history', 'History')}
        </nav>`
  return html`
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${args.title} · arkade-nwc-bridge</title>
  <style>${raw(STYLES)}</style>
</head>
<body>
  ${nav}
  <h1>${args.title}</h1>
  ${args.body}
  ${args.current === 'setup' ? html`` : raw(LIVE_SCRIPT)}
</body>
</html>`
}

// Subscribes to the server's SSE stream and swaps in fresh fragments
// when relay status changes. Server-rendered HTML is the source of truth
// for the markup shape; the client just replaces innerHTML on elements
// tagged with data-relay-summary / data-relay-detail.
//
// EventSource auto-reconnects, so a bridge restart resumes the feed
// without page reload. Safe to no-op in setup mode (no /events route
// behavior, but the request just sits idle).
const LIVE_SCRIPT = `<script>
(function () {
  if (typeof EventSource === 'undefined') return
  var es = new EventSource('/events')
  es.addEventListener('relay-status', function (ev) {
    try {
      var data = JSON.parse(ev.data)
      document.querySelectorAll('[data-relay-summary]').forEach(function (el) {
        el.innerHTML = data.summaryHtml
      })
      document.querySelectorAll('[data-relay-detail]').forEach(function (el) {
        el.innerHTML = data.detailHtml
      })
    } catch (e) {
      // swallow — a malformed frame shouldn't break the page
    }
  })
})()
</script>`
