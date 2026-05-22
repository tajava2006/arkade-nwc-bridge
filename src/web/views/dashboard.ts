import { html, type RawHtml } from '../../lib/html'
import { layout } from './layout'

export function dashboardView(args: {
  balanceMsat: number
  arkAddress: string
  activeConnections: number
  totalTxCount: number
}): RawHtml {
  const balanceSats = Math.floor(args.balanceMsat / 1000)
  return layout({
    title: 'Dashboard',
    current: 'dashboard',
    body: html`
      <div class="stat">
        <div class="stat-label">Balance</div>
        <div class="stat-value">${balanceSats.toLocaleString()} sats</div>
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
    `,
  })
}
