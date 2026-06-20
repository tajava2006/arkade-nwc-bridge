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

export function dashboardView(args: {
  balance: WalletBalance | null
  arkAddress: string
  noffer: string
  offerRelay: RelayStatus
  activeConnections: number
  totalTxCount: number
}): RawHtml {
  const relay = args.offerRelay
  const relayBadge = relay.connected
    ? html`<span class="ok">● up</span>`
    : html`<span class="bad">○ down</span>`
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
      <h2>Ark address</h2>
      <pre>${args.arkAddress}</pre>
      <p class="muted">Send sats here to top up the bridge wallet. NWC clients spend through Lightning via Boltz swaps; the address itself is for onchain / Ark deposits.</p>
      <h2>Lightning receive code (CLINK noffer)</h2>
      <div class="qr-box">${raw(qrSvg(args.noffer))}</div>
      <pre>${args.noffer}</pre>
      <p class="muted">A static, Nostr-native receive code — no web server, no Lightning Address domain. A CLINK-compatible payer scans this, names an amount, and the bridge returns a Lightning invoice that settles onto Ark. Spontaneous amount.</p>
      <p class="muted">Relay <code>${relay.url}</code> ${relayBadge} — the code embeds this one relay. If it keeps dropping, the code stops working; regenerate to mint a fresh one from your current outbox relay (this invalidates the code above, so update wherever you shared it).</p>
      <form method="post" action="/noffer/regenerate" onsubmit="return confirm('Regenerate the noffer? The current code will stop working.');">
        <button type="submit">Regenerate noffer</button>
      </form>
    `,
  })
}
