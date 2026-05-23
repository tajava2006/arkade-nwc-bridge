import { html, raw, type RawHtml } from '../../lib/html'
import { layout } from './layout'

export function setupView(args?: {
  error?: string
  pastedNsec?: string
}): RawHtml {
  return layout({
    title: 'Welcome',
    current: 'setup',
    body: html`
      <p>This bridge needs an Ark identity (nsec) to talk to the Ark server, Boltz, and your nostr clients. The nsec is stored in this machine's SQLite file and never leaves it.</p>

      ${args?.error ? html`<p style="color:#c00"><strong>${args.error}</strong></p>` : null}

      <h2>Paste an existing nsec</h2>
      <p class="muted">From your Arkade Wallet backup (delegation must be disabled — see README) or any nostr key you control.</p>
      <form action="/setup" method="post">
        <input type="hidden" name="mode" value="paste" />
        <label>
          nsec1… (or 64-char hex)
          <input
            type="text"
            name="nsec"
            placeholder="nsec1..."
            value="${args?.pastedNsec ?? ''}"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <button type="submit">Use this nsec</button>
      </form>

      <h2>Or generate a fresh one</h2>
      <p class="muted">A new key is created and saved. You'll see it on the next screen so you can back it up — and it stays viewable in the bridge UI later.</p>
      <form action="/setup" method="post">
        <input type="hidden" name="mode" value="generate" />
        <button type="submit">Generate new nsec</button>
      </form>
    `,
  })
}

export function setupGeneratedView(args: { nsec: string }): RawHtml {
  return layout({
    title: 'Account created',
    current: 'setup',
    body: html`
      <p>A fresh Ark identity was created and saved. Back it up now — losing this nsec means losing access to any funds sent to its Ark address.</p>

      <h2>Your nsec</h2>
      <pre>${args.nsec}</pre>
      <p class="muted">You can view this again from the bridge UI at any time.</p>

      <p><a href="/">Continue to dashboard →</a></p>
    `,
  })
}

// Standalone version for the "wallet is still booting" interstitial after
// /setup POST returns — the wallet/boltz/nostr bring-up is already done by
// the time the response renders, so this is mainly a tidy success page.
export function setupImportedView(): RawHtml {
  return layout({
    title: 'Account imported',
    current: 'setup',
    body: html`
      <p>Identity imported and the wallet is online.</p>
      <p><a href="/">Continue to dashboard →</a></p>
    `,
  })
}

// Used as a guard when ready-mode pages are hit while the user is still in
// setup. Just a friendly redirect target with a link, in case the browser
// arrives via "back" after revoking the account row manually.
export function setupRedirectNotice(): RawHtml {
  return layout({
    title: 'Setup required',
    current: 'setup',
    body: html`
      <p>No account is configured. <a href="/setup">Set up the bridge →</a></p>
    `,
  })
}

// Suppress the unused warning if html/raw are imported but a branch isn't
// taken — keeps the future-edit ergonomics. (raw stays in the import list
// in case the view grows server-side SVG or qr later.)
void raw
