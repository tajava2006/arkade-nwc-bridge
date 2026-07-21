import { html, type RawHtml } from '../../lib/html'

// Shared display primitives for copy-worthy identifiers and timezone-correct
// timestamps. Both lean on the global handlers in layout.ts's LIVE_SCRIPT:
// a delegated click-to-copy for [data-copy], and localizeTimes() for [data-ts].

/**
 * A truncated identifier that copies its *full* value on click. The visible
 * text is the caller's short form (existing slice logic); the full value rides
 * in data-copy and the shared handler writes it to the clipboard. This is for
 * txids / outpoints / addresses that must stay short so table rows don't blow
 * out horizontally, yet need to be pasteable — a `title` tooltip shows the full
 * value on hover but can't be copied, which was the actual pain point.
 */
export function copyable(full: string, short: string): RawHtml {
  return html`<code class="copy" data-copy="${full}" title="Click to copy: ${full}">${short}</code>`
}

/**
 * Standalone copy button — used where the value's own element already owns the
 * click (e.g. it's a link), so click-to-copy on the text would hijack
 * navigation. Sits next to the value.
 */
export function copyIcon(full: string): RawHtml {
  return html`<button type="button" class="copy-icon" data-copy="${full}" title="Copy ${full}" aria-label="Copy">⧉</button>`
}

/**
 * A timestamp shown in the *viewer's* timezone. The bridge container has no TZ
 * set, so any server-side toLocaleString() renders UTC while the operator's
 * browser is elsewhere. Instead we emit the epoch (ms) and let localizeTimes()
 * format it client-side. The fallback text (before JS runs / no-JS) is the UTC
 * ISO minute, explicitly marked so it's never mistaken for local time.
 */
export function localTime(unixMs: number): RawHtml {
  const iso = new Date(unixMs).toISOString().slice(0, 16).replace('T', ' ')
  return html`<time data-ts="${unixMs}">${iso} UTC</time>`
}
