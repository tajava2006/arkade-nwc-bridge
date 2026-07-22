import { html, raw, type RawHtml } from '../../lib/html'
import { layout } from './layout'
import {
  ARK_SERVER_URL,
  BOLTZ_API_URL,
  OFFICIAL_ARK_SERVER_URL,
  OFFICIAL_BOLTZ_API_URL,
} from '../../defaults'

export type ServerChoice = 'hoppe' | 'official' | 'custom'

export function setupView(args?: {
  error?: string
  pastedNsec?: string
  // Which server radio is checked. Default the operator's own (`hoppe`).
  choice?: ServerChoice
  // Custom Ark/Boltz inputs, preserved across error re-renders.
  customArk?: string
  customBoltz?: string
  // data/config.json pins ark/boltz → it overrides the chosen row at runtime.
  configPinned?: boolean
}): RawHtml {
  const choice = args?.choice ?? 'hoppe'
  const checked = (c: ServerChoice): RawHtml | null => (choice === c ? raw('checked') : null)
  return layout({
    title: 'Welcome',
    current: 'setup',
    body: html`
      <style>
        /* Setup fills the page like the intro instead of the global 420px form
           cap that left it in the left half; inputs stay a sane width. */
        form.setup-form { max-width: none }
        .setup-form input { max-width: 34rem }
        .setup-actions { display: flex; gap: 0.6rem; flex-wrap: wrap }
        .setup-server label.opt { display: block; margin: 0.7rem 0 0.1rem; font-weight: 600 }
        .setup-server .note { margin: 0.15rem 0 0.2rem 1.5rem }
        .setup-custom { margin: 0.4rem 0 0 1.5rem }
      </style>

      <p>This bridge needs the server it will talk to (an Ark + Boltz pair) and an Ark identity (nsec). Both are set once, here. The <strong>server choice is then locked to this wallet</strong> — changing it means draining the funds and starting over from a fresh database (there is no multi-server wallet). The nsec is stored in this machine's SQLite file and never sent to the browser again after this flow.</p>

      ${args?.error ? html`<p style="color:#c00"><strong>${args.error}</strong></p>` : null}

      <form action="/setup" method="post" class="setup-form">
        <div class="setup-server">
          <h2>Server</h2>
          ${args?.configPinned
            ? html`<p class="note bad"><code>data/config.json</code> pins the server URLs, so it overrides this choice at runtime — what you pick here is only recorded.</p>`
            : null}

          <label class="opt"><input type="radio" name="server_choice" value="hoppe" ${checked('hoppe')} /> This bridge's operator — recommended</label>
          <p class="note muted">${ARK_SERVER_URL} + ${BOLTZ_API_URL}<br />Full <strong>atomic sub-dust</strong> support — Lightning swaps for <strong>any amount below the 330-sat dust limit, down to a 1-sat zap</strong>, work here.</p>
          <p class="note muted">A one-person server, so liquidity is finite: <strong>sending out of Ark</strong> — a cooperative offboard to the chain, or a Lightning payment — is capped at what the operator has stocked. That does <strong>not</strong> make it custodial. In Ark your ownership is the <strong>unilateral-exit</strong> right, not the operator's cooperation: whatever the server's liquidity, you can move <strong>every sat you put here</strong> onto the chain yourself, without the operator — only <em>cooperative</em> exit is liquidity-bound. Funds coming <strong>in</strong> have no cap.</p>

          <label class="opt"><input type="radio" name="server_choice" value="official" ${checked('official')} /> Official Arkade (Ark Labs)</label>
          <p class="note muted">${OFFICIAL_ARK_SERVER_URL} + ${OFFICIAL_BOLTZ_API_URL}<br />Standard swaps, offboarding, full balance drain and unilateral exit all work. But the official Boltz has <strong>no sub-dust endpoints</strong>, so anything below the 330-sat dust limit (a 1-sat zap, say) won't swap.</p>
          <p class="note muted">Paste that same official Arkade wallet's nsec (below) and the bridge shows <em>its</em> balance too — the same key on the same server is the same wallet. Catch: only with <strong>delegation turned OFF</strong>. An Ark address is a script address, and delegation adds a tapleaf that changes the address itself, so a delegation-on wallet lands on a different address the bridge never sees. To try it: create a fresh official Arkade wallet, switch delegation off, then fund it — that one is tracked correctly.</p>

          <label class="opt"><input type="radio" name="server_choice" value="custom" ${checked('custom')} /> Custom — your own Ark + Boltz</label>
          <p class="note muted">Nothing can verify a pair is matched — an Ark server doesn't advertise which Boltz serves it — so <strong>make sure both belong to the same operator</strong>. A mismatch is accepted at setup but misbehaves later. (Fields below are used only with this option.)</p>
          <div class="setup-custom">
            <label>
              Ark server URL
              <input type="text" name="ark_url" placeholder="https://ark.example.com" value="${args?.customArk ?? ''}" autocomplete="off" spellcheck="false" />
            </label>
            <label>
              Boltz API URL
              <input type="text" name="boltz_url" placeholder="https://boltz.example.com" value="${args?.customBoltz ?? ''}" autocomplete="off" spellcheck="false" />
            </label>
          </div>
        </div>

        <h2>Identity</h2>
        <p class="muted">Paste an existing nsec (from your Arkade Wallet backup — delegation must be disabled, see README — or any nostr key you control) and use it, or leave it blank and generate a fresh one. A generated key is shown once on the next screen so you can back it up — after that the web UI never renders it again (recover it with <code>bun run show-nsec</code>).</p>
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
        <div class="setup-actions">
          <button type="submit" name="mode" value="paste">Use this nsec</button>
          <button type="submit" name="mode" value="generate">Generate new nsec</button>
        </div>
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
      <p class="bad">This is the only time the web UI shows the nsec — a browser is the least trusted surface on this machine, so it is deliberately never sent here again. It lives (hex-encoded) in <code>./data/bridge.sqlite</code>; run <code>bun run show-nsec</code> in the bridge directory whenever you need it back in nsec form.</p>
      <p class="muted">This key is also a full nostr identity. A good backup home is a nostr signer on your phone — <a href="https://github.com/greenart7c3/Amber">Amber</a> (Android) or Clave (iOS) — which stores it encrypted and lets you use the same identity across nostr apps later.</p>

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
