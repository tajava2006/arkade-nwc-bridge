import type { WalletBalance } from '@arkade-os/sdk'
import { html, raw, type RawHtml } from '../../lib/html'
import type { RelayStatus } from '../../lib/relay_status'
import type { ProofSyncSnapshot } from '../../exit/sync_service'
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
 * Exit-readiness tile: claim vs proof. Headline is "proven/claimed" where
 * *claimed* is the vtxo count the ASP itself credited on the last successful
 * listVtxos and *proven* is how many vtxos are fully exitable from the local
 * vault right now. The denominator is deliberately NOT the vault's row count:
 * a vtxo the server credits but whose chain never made it into the vault
 * would drop out of a vault-based denominator entirely — "3/3" green while
 * the ASP says you own 4. proven < claimed means the difference exists only
 * on the server's word, so it shows as a loud warning, not a muted sync note
 * (EXIT_PLAN §6 "증명 신선도 = 탈출 가능성").
 */
export function renderExitReadinessFragment(snap: ProofSyncSnapshot | null): RawHtml {
  if (!snap) {
    return html`<span class="muted">Loading…</span>`
  }
  const { stats, claim, lastRun, running } = snap
  if (!claim && !lastRun && !running) {
    return html`<span class="muted">first sync pending</span>`
  }
  const proven = stats.readyCount
  // claim === null past this point means every pass so far died inside
  // listVtxos — the ASP has never told us what it credits, so there is
  // nothing to compare against. Don't render that as green.
  const headline =
    claim === null
      ? html`<span class="bad">${proven}/?</span>`
      : proven < claim.total
        ? html`<span class="bad">${proven}/${claim.total}</span>`
        : html`<span class="ok">${proven}/${claim.total}</span>`
  const agoSec = lastRun ? Math.max(0, Math.floor(Date.now() / 1000) - lastRun.at) : null
  const freshness = running
    ? 'syncing…'
    : agoSec === null
      ? 'never synced'
      : agoSec < 90
        ? `synced ${agoSec}s ago`
        : `synced ${Math.floor(agoSec / 60)}m ago`
  const shortfall =
    claim === null
      ? html`<div class="bad">ASP claim unknown — vtxo listing has never succeeded</div>`
      : proven < claim.total
        ? html`<div class="bad">
            ⚠ ASP credits ${claim.total} vtxo(s) but exit proofs cover only ${proven} — the
            other ${claim.total - proven} exist only on the server's word
          </div>`
        : html``
  const gaps =
    lastRun && lastRun.failed.length > 0
      ? html`<div class="bad">${lastRun.failed.length} sync gap(s) — retrying</div>`
      : html``
  // Quarantine outranks everything above: the ASP dropped vtxo(s) it cannot
  // justify. Their pre-signed exit chains are retained — point at /exit.
  const quarantine =
    stats.quarantinedCount > 0
      ? html`<div class="bad">
          ⚠ ${stats.quarantinedCount} vtxo(s) QUARANTINED — the ASP dropped them without
          evidence. Proofs kept; <a href="/exit">exit them before expiry</a>.
        </div>`
      : html``
  // Different story, different tone: these lapsed before a refresh (user's
  // side of the bargain) and the server dropped them. Nothing exitable —
  // but nothing is allowed to just vanish either.
  const expired =
    stats.expiredCount > 0
      ? html`<div class="bad">
          ${stats.expiredCount} vtxo(s) expired unrefreshed and the ASP dropped them —
          <a href="/exit">review &amp; forget</a>.
        </div>`
      : html``
  return html`${headline}
    <div class="muted" style="font-size:0.55em; font-weight: normal;">
      proven / ASP-claimed · ${freshness} · proofs ${(stats.proofBytes / 1024).toFixed(0)} KB
    </div>
    ${quarantine} ${expired} ${shortfall} ${gaps}`
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
  exitReadiness: ProofSyncSnapshot | null
  arkAddress: string
  boardingAddress: string
  onboardingFeeProgram?: string
  noffer: string
  offerRelay: RelayStatus
  activeConnections: number
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
        <div class="stat-label">Exit readiness</div>
        <div class="stat-value" data-exit-readiness>${renderExitReadinessFragment(args.exitReadiness)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Active connections</div>
        <div class="stat-value">${args.activeConnections}</div>
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
