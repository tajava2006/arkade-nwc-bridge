import type { WalletBalance } from '@arkade-os/sdk'
import { html, raw, type RawHtml } from '../../lib/html'
import type { RelayStatus } from '../../lib/relay_status'
import { qrSvg } from '../qr'
import { layout } from './layout'

/**
 * Inner content of the Balance stat tile. Returned alone so the SSE
 * channel can swap just this fragment into [data-balance] when a
 * fresh wallet.getBalance() lands. `null` means the cache is empty
 * (first visit since boot, fetch in flight) — render a loading hint.
 */
export function renderBalanceFragment(balance: WalletBalance | null): RawHtml {
  if (!balance) {
    return html`<span class="muted">Loading…</span>`
  }
  // Include recoverable: those are sub-dust VTXOs still belonging to
  // the wallet, just not freely spendable right now. NWC clients see
  // the same composite in get_balance, so the dashboard should match.
  const sats = balance.available + balance.recoverable
  return html`${sats.toLocaleString()} sats`
}

/**
 * Render the ASP onboarding fee from its onchain-input intent-fee CEL program.
 * Flat configs (e.g. "1000.0") show the sat amount; anything amount-dependent
 * can't be a single number, and a missing program means getInfo failed at boot.
 */
function renderOnboardingFee(program: string | undefined): string {
  if (!program) return 'an onboarding fee set by the ASP'
  const t = program.trim()
  // Flat constant config → exact, fixed amount: show "=" not "≈".
  if (/^\d+(\.\d+)?$/.test(t)) {
    return `= ${Math.round(Number.parseFloat(t)).toLocaleString()} sats (fixed)`
  }
  return 'an onboarding fee set by the ASP (varies by amount)'
}

export function dashboardView(args: {
  balance: WalletBalance | null
  arkAddress: string
  boardingAddress: string
  onboardingFeeProgram?: string
  noffer: string
  offerRelay: RelayStatus
  activeConnections: number
  totalTxCount: number
}): RawHtml {
  const relay = args.offerRelay
  const relayBadge = relay.connected
    ? html`<span class="ok">● up</span>`
    : html`<span class="bad">○ down</span>`
  const onboardingFee = renderOnboardingFee(args.onboardingFeeProgram)
  return layout({
    title: 'Dashboard',
    current: 'dashboard',
    body: html`
      <div class="stat">
        <div class="stat-label">Balance</div>
        <div class="stat-value" data-balance>${renderBalanceFragment(args.balance)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Active connections</div>
        <div class="stat-value">${args.activeConnections}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Transactions</div>
        <div class="stat-value">${args.totalTxCount}</div>
      </div>

      <h2>Receive — three ways to deposit</h2>
      <div class="receive-grid">
        <div class="receive-card">
          <h3>Ark address</h3>
          <div class="qr-box">${raw(qrSvg(args.arkAddress))}</div>
          <pre>${args.arkAddress}</pre>
          <p class="muted">Offchain L2 deposit: someone sends a VTXO straight here. Instant and free.</p>
        </div>

        <div class="receive-card">
          <h3>Lightning (CLINK noffer)</h3>
          <div class="qr-box">${raw(qrSvg(args.noffer))}</div>
          <pre>${args.noffer}</pre>
          <p class="muted">Static, Nostr-native — no web server, no Lightning Address domain. A CLINK payer scans it, names an amount, and the invoice settles onto Ark. Fee: a fixed Boltz swap fee (ours), plus Lightning routing the sender pays (variable).</p>
          <p class="muted">Relay <code>${relay.url}</code> ${relayBadge} — the code embeds this one relay. If it keeps dropping, regenerate to mint a fresh one from your current outbox relay (this invalidates the code above, so update wherever you shared it).</p>
          <form method="post" action="/noffer/regenerate" onsubmit="return confirm('Regenerate the noffer? The current code will stop working.');">
            <button type="submit">Regenerate noffer</button>
          </form>
        </div>

        <div class="receive-card">
          <h3>Onchain (boarding)</h3>
          <div class="qr-box">${raw(qrSvg(args.boardingAddress))}</div>
          <pre>${args.boardingAddress}</pre>
          <p class="muted">Onchain BTC that converts to a VTXO. It won't show in your balance until the deposit confirms — only then does a settlement round convert it. Fee: the onchain mining fee you pay to send (variable), plus ${onboardingFee} the ASP deducts on conversion.</p>
        </div>
      </div>
    `,
  })
}
