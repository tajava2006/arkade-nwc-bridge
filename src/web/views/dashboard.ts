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
 * The boarding card's fee sentence, from the ASP's onchain-input intent-fee
 * CEL program. Our policy is to charge nothing on the way in, so the
 * empty/zero program renders as "no ASP fee" — but the sentence stays wired
 * to the live config rather than hardcoding that promise: if the program is
 * ever set, the card tells the truth without a copy change.
 */
function onboardingFeeNote(program: string | undefined): string {
  const t = (program ?? '').trim()
  const flat = /^\d+(\.\d+)?$/.test(t) ? Math.round(Number.parseFloat(t)) : null
  if (t === '' || flat === 0) {
    return 'Fee: just the onchain mining fee you pay to send it — nothing else. The ASP deducts nothing on conversion.'
  }
  const asp =
    flat !== null
      ? `${flat.toLocaleString()} sats (fixed)`
      : 'an onboarding fee set by the ASP (varies by amount)'
  return `Fee: the onchain mining fee you pay to send (variable), plus ${asp} the ASP deducts on conversion.`
}

/**
 * The Lightning card's fee sentence, from the live Boltz fee table (reverse =
 * receive direction). Same idea as the boarding note: policy is 0% on receive,
 * but the sentence follows the config. `null` = fee table not fetched yet —
 * claim nothing rather than promising free.
 */
function lnReceiveFeeNote(reverseFeePct: number | null): string {
  if (reverseFeePct === 0) {
    return 'Fee: none — the invoiced amount lands on Ark in full. The sender covers their own Lightning routing fee (variable), as with any LN payment.'
  }
  if (reverseFeePct === null) {
    return 'The sender covers their own Lightning routing fee (variable), as with any LN payment.'
  }
  return `Fee: a ${reverseFeePct}% swap fee comes out of what lands on Ark, plus Lightning routing the sender pays (variable).`
}

export function dashboardView(args: {
  balance: WalletBalance | null
  exitReadiness: ProofSyncSnapshot | null
  arkAddress: string
  boardingAddress: string
  onboardingFeeProgram?: string
  /** Boltz reverse-swap (receive) fee %, from the send-data cache; null until fetched. */
  reverseFeePct: number | null
  noffer: string
  offerRelay: RelayStatus
  activeConnections: number
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
          <p class="muted">Static, Nostr-native — no web server, no Lightning Address domain. A CLINK payer scans it, names an amount, and the invoice settles onto Ark. ${lnReceiveFeeNote(args.reverseFeePct)}</p>
          <p class="muted">Relay <code>${relay.url}</code> ${relayBadge} — the code embeds this one relay. If it keeps dropping, regenerate to mint a fresh one from your current outbox relay (this invalidates the code above, so update wherever you shared it).</p>
          <form method="post" action="/noffer/regenerate" onsubmit="return confirm('Regenerate the noffer? The current code will stop working.');">
            <button type="submit">Regenerate noffer</button>
          </form>
        </div>

        <div class="receive-card">
          <h3>Onchain (boarding)</h3>
          <div class="qr-box">${raw(qrSvg(args.boardingAddress))}</div>
          <pre>${args.boardingAddress}</pre>
          <p class="muted">Onchain BTC that converts to a VTXO. It won't show in your balance until the deposit confirms — only then does a settlement round convert it. ${onboardingFeeNote(args.onboardingFeeProgram)}</p>
        </div>
      </div>
    `,
  })
}
