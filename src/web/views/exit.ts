import { html, type RawHtml } from '../../lib/html'
import type { VaultVtxo, VaultStats } from '../../exit/vault'
import type { ExitEstimate } from '../../exit/estimate'
import type { ExitOp } from '../../exit/ops'
import type { ExitDest } from '../../exit/dest'
import type { FinalSendInfo } from '../../exit/final_send'
import { layout } from './layout'
import { copyIcon } from './ui'
import { fundingPanel } from './exit_detail'

// The /exit tab (EXIT_PLAN #12): one row per mirrored vtxo, execution
// strictly per-vtxo (§1 — no bulk button, ever). Every number a user needs
// to answer "is pulling this one out worth it" sits in the row: expiry (the
// hard deadline — after the ASP sweeps, proofs are dead), proof
// completeness, and the measured cost of the full unroll+sweep at the
// current fee rate with an explicit losing-money verdict.

export interface ExitRow {
  vtxo: VaultVtxo
  ready: boolean
  estimate: ExitEstimate | null
  op: ExitOp | null
}

function fmtSats(n: number): string {
  return `${n.toLocaleString()} sats`
}

function short(txid: string): string {
  return `${txid.slice(0, 8)}…${txid.slice(-6)}`
}

export function expiryCountdown(expiresAt: number | null, nowSec: number): RawHtml {
  if (expiresAt === null) return html`<span class="muted">unknown</span>`
  const d = expiresAt - nowSec
  if (d <= 0) return html`<span class="bad">EXPIRED — proofs are dead paper</span>`
  const days = Math.floor(d / 86_400)
  const hours = Math.floor((d % 86_400) / 3_600)
  const label = days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((d % 3_600) / 60)}m`
  // under two days the ASP sweep race is uncomfortably near — surface it
  return d < 2 * 86_400
    ? html`<span class="bad">${label} left</span>`
    : html`<span>${label} left</span>`
}

// Quarantine is orthogonal to exitability — a quarantined vtxo with complete
// proofs is exactly the row you want to exit NOW, so the flag rides next to
// the verdict instead of replacing it. Once the window has closed the label
// flips: nothing exitable remains, the ask is "review & forget", and calling
// an unrefreshed lapse a QUARANTINE would dress user fault up as betrayal.
// A flag younger than the grace window (same clock as the betrayal DM) is
// almost always a transient — the sync pass racing an in-flight settle —
// so it renders as a fact under verification, not a verdict.
function quarantinePill(v: VaultVtxo, nowSec: number, graceSec: number): RawHtml {
  if (v.quarantinedAt === null) return html``
  if (nowSec - v.quarantinedAt < graceSec) {
    return html`<span
      class="pill pending"
      title="${v.quarantineReason ?? 'dropped from the live set'}"
      >dropped — verifying</span
    > `
  }
  const windowClosed = v.expiresAt !== null && v.expiresAt <= nowSec
  return html`<span
    class="pill failed"
    title="${v.quarantineReason ?? 'ASP dropped this vtxo without evidence'}"
    >${windowClosed ? 'EXPIRED — REVIEW' : 'QUARANTINED'}</span
  > `
}

function verdict(row: ExitRow): RawHtml {
  if (row.vtxo.status === 'swept') {
    // §2.7: the ASP already spent the tree root — complete proofs or not,
    // unilateral exit is gone; only a cooperative settlement recovers this
    return html`<span class="pill failed">unilateral exit impossible — cooperative recovery only</span>`
  }
  if (!row.ready) {
    return html`<span class="pill pending">proofs incomplete — cannot exit offline yet</span>`
  }
  if (row.estimate?.uneconomical) {
    return html`<span class="pill failed">exiting loses money (fees ≥ value)</span>`
  }
  return html`<span class="pill settled">exitable</span>`
}

function estimateCell(est: ExitEstimate | null): RawHtml {
  if (!est) return html`<span class="muted">—</span>`
  const pct = Number.isFinite(est.feePctOfValue) ? `${est.feePctOfValue}%` : '∞'
  return html`${est.packages} tx + sweep · ${est.totalVb.toLocaleString()} vB ·
    ~${fmtSats(est.totalFeeSat)} <span class="muted">(${pct} of value)</span>`
}

function opPill(op: ExitOp | null): RawHtml {
  if (!op) return html`<span class="muted">—</span>`
  const cls =
    op.state === 'swept' ? 'settled' : op.state === 'failed' ? 'failed' : 'pending'
  return html`<span class="pill ${cls}" data-exit-op-state>${op.state}</span>`
}

export function renderExitRows(rows: ExitRow[], nowSec: number, graceSec = 0): RawHtml {
  if (rows.length === 0) {
    return html`<tr><td colspan="6" class="muted">The vault has no mirrored vtxos.</td></tr>`
  }
  return html`${rows.map(
    (row) => html`
      <tr data-exit-row="${row.vtxo.txid}:${row.vtxo.vout}">
        <td><a href="/exit/${row.vtxo.txid}/${row.vtxo.vout}"><code>${short(row.vtxo.txid)}:${row.vtxo.vout}</code></a>${copyIcon(`${row.vtxo.txid}:${row.vtxo.vout}`)}</td>
        <td class="num">${fmtSats(row.vtxo.valueSat)}</td>
        <td>${expiryCountdown(row.vtxo.expiresAt, nowSec)}</td>
        <td>${estimateCell(row.estimate)}</td>
        <td>${quarantinePill(row.vtxo, nowSec, graceSec)}${verdict(row)}</td>
        <td>${opPill(row.op)}</td>
      </tr>
    `,
  )}`
}

export interface ExitSummary {
  total: number
  swept: number
  unresolved: number
}

// The last mile (EXIT_PLAN #17): everything the exit accumulated on the
// fuel P2TR → an address the user PROVED they control. The proof is a
// challenge signature — a mistyped or clipboard-swapped address can't
// produce one — and it is REQUIRED: the escape hatch for wallets that
// can't sign messages is `bun run show-btc-key` (import the key itself),
// never an unverified send.
function finalSendSection(args: {
  dest: ExitDest | null
  summary: ExitSummary
  sendInfo: FinalSendInfo | null
  fundingBalanceSat: number | null
}): RawHtml {
  const { dest, summary, sendInfo } = args

  const addressForm = html`
    <form method="post" action="/exit/dest">
      <label>Destination address (yours — a cold wallet, another wallet you hold the keys to):
        <input name="address" size="64" placeholder="bc1..." required
          value="${dest && !dest.verifiedAt ? dest.address : ''}" />
      </label>
      <button type="submit">${dest ? 'Re-issue challenge' : 'Get signing challenge'}</button>
    </form>
    <p class="muted">
      Alternative that needs no signature: <code>bun run show-btc-key</code> prints this
      wallet's key as WIF + <code>tr()</code> descriptor — import it into any descriptor
      wallet, rescan, done. The funds never depended on this bridge.
    </p>
  `

  if (!dest) {
    return html`
      <h2>Final send — move everything to YOUR address</h2>
      <p class="muted">
        The fuel address above is already yours alone, but its key lives in this
        bridge. To finish an exit properly, sweep the fuel change plus every swept
        vtxo to an address whose key you hold elsewhere. To rule out a paste error,
        the bridge will only send to an address after you sign a challenge with
        that address's key.
      </p>
      ${addressForm}
    `
  }

  if (!dest.verifiedAt) {
    return html`
      <h2>Final send — prove the destination is yours</h2>
      <p>Sign this exact text with the key of <code>${dest.address}</code>
        (message signing in Sparrow/Electrum/your hardware wallet; BIP-322 or the
        classic signed-message format both verify):</p>
      <pre>${dest.challenge}</pre>
      <form method="post" action="/exit/dest/verify">
        <label>Signature (base64):
          <textarea name="signature" rows="3" cols="80" required></textarea>
        </label>
        <button type="submit">Verify signature</button>
      </form>
      <p class="muted">
        Wallet can't sign for this address type (common for taproot-only cold
        wallets)? There is deliberately no skip — use a different address the
        wallet CAN sign for, or take the <code>show-btc-key</code> route below.
      </p>
      ${addressForm}
      <form method="post" action="/exit/dest/clear">
        <button type="submit" class="muted">Clear destination</button>
      </form>
    `
  }

  const unresolvedNote =
    summary.unresolved > 0
      ? html`<p class="bad">
          ${summary.swept} of ${summary.total} vaulted vtxo(s) are swept; ${summary.unresolved}
          are not. If those are stuck because the exit cost exceeds their value, that is a
          judgment call you already made — but check the table above one last time before
          sending: after this, topping up fuel to exit them means paying onchain again.
        </p>`
      : html`<p class="muted">All ${summary.total} vaulted vtxo(s) are swept — nothing left behind.</p>`

  const sendState = sendInfo
    ? sendInfo.confirmed
      ? html`<p>Last send <code>${short(sendInfo.sendTxid)}</code> is <strong>confirmed</strong>.
          Anything landing on the fuel address afterwards can be sent again below.</p>`
      : html`<p>
          Send <code>${short(sendInfo.sendTxid)}</code> in mempool —
          ${sendInfo.feeSat.toLocaleString()} sats fee (${sendInfo.rateSatVb} sat/vB, next block
          ~${sendInfo.targetRateSatVb} sat/vB)${sendInfo.blocksWaiting !== null
            ? html` · waiting ${sendInfo.blocksWaiting} block(s)`
            : html``}
        </p>
        ${sendInfo.boostable
          ? html`<form method="post" action="/exit/final-send/boost">
              <button type="submit">Boost fee (RBF)</button>
            </form>`
          : html``}`
    : dest.sendTxid
      ? html`<p class="muted">Last send <code>${short(dest.sendTxid)}</code> — status unknown (esplora unreachable).</p>`
      : html``

  return html`
    <h2>Final send — destination verified</h2>
    <p>
      <code>${dest.address}</code>
      <span class="pill settled">ownership proven (${dest.scheme})</span>
    </p>
    ${unresolvedNote}
    ${sendState}
    <form method="post" action="/exit/final-send"
      onsubmit="return confirm('Send the ENTIRE fuel balance (${args.fundingBalanceSat === null ? 'balance unknown' : `${args.fundingBalanceSat.toLocaleString()} sats`} minus one exact miner fee) to ${dest.address}?');">
      <button type="submit">Send everything → ${short6(dest.address)}</button>
    </form>
    <p class="muted">
      One transaction, all confirmed fuel coins, no change output: the fee is computed
      from the exact tx size at the current next-block rate and everything else goes to
      your address. RBF stays available above if it lags. Unconfirmed fuel coins are
      left for a later send.
    </p>
    <form method="post" action="/exit/dest/clear">
      <button type="submit" class="muted">Clear destination</button>
    </form>
  `
}

function short6(addr: string): string {
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`
}

// Fuel needed to pull every still-exitable row, for the list page's low-fuel
// check. Swept rows are done and sweep-impossible rows never draw fuel; rows
// without an estimate can't be priced, so the sum is a floor, not a promise.
function aggregateNeededSat(rows: ExitRow[]): number | null {
  const priced = rows.filter(
    (r) => r.vtxo.status !== 'swept' && r.op?.state !== 'swept' && r.estimate !== null,
  )
  if (priced.length === 0) return null
  return priced.reduce((sum, r) => sum + (r.estimate?.totalFeeSat ?? 0), 0)
}

/** shown when a final-send action (challenge, verify, send, boost) is rejected */
export function exitFinalError(action: string, reason: string): RawHtml {
  return layout({
    title: `${action} failed`,
    current: 'exit',
    body: html`
      <p><a href="/exit">← back to exit</a></p>
      <p class="bad">${action} failed: ${reason}</p>
    `,
  })
}

export function exitView(args: {
  rows: ExitRow[]
  feeRate: number
  degraded: boolean
  stats: VaultStats
  nowSec: number
  /** badge/pill grace, seconds — flags younger than this render muted (0 = off) */
  graceSec?: number
  fundingAddress: string
  fundingBalanceSat: number | null
  dest: ExitDest | null
  summary: ExitSummary
  sendInfo: FinalSendInfo | null
}): RawHtml {
  const { rows, stats } = args
  return layout({
    title: 'Unilateral exit',
    current: 'exit',
    body: html`
      ${args.degraded
        ? html`<p class="bad">Degraded mode — the ASP is unreachable. Everything on this
            page works from the local vault and esplora only.</p>`
        : html``}
      ${stats.quarantinedCount > 0
        ? html`<p class="bad">
            ⚠ ${stats.quarantinedCount} vtxo(s) quarantined: the ASP dropped them from the
            live set without verifiable evidence (no spend signed by your key, not expired).
            Their pre-signed proofs are kept — if the server is cheating, exiting them below
            is the recourse, and it only works until expiry.
          </p>`
        : html``}
      ${stats.expiredCount > 0
        ? html`<p class="bad">
            ${stats.expiredCount} vtxo(s) expired before a refresh and the ASP has dropped
            them. That lapse is on this wallet's side — but nothing gets deleted silently:
            open each row below and use <em>Forget</em> once you've made peace with it.
          </p>`
        : html``}
      ${stats.inGraceCount > 0
        ? html`<p class="muted">
            ${stats.inGraceCount} vtxo(s) recently dropped from the live set — being
            re-verified. A transient drop (a settlement in flight, indexer lag) clears on
            the next sync pass; it turns into a quarantine only if it persists.
          </p>`
        : html``}
      <p class="muted">
        ${stats.readyCount}/${stats.vtxoCount} vtxos exit-ready · proofs
        ${(stats.proofBytes / 1024).toFixed(0)} KB · fee rate ${args.feeRate} sat/vB ·
        costs are measured from the pre-signed txs, not guessed. Exits run
        <strong>one vtxo at a time</strong> — judge each row before pulling it.
        Clicking a row is always safe: it opens a <strong>read-only view</strong> of
        that vtxo's pre-signed exit chain and cost. Nothing is broadcast until you
        press <em>Start exit</em> on that page and confirm.
      </p>
      <table>
        <tr>
          <th>vtxo</th>
          <th class="num">value</th>
          <th>expiry (exit deadline)</th>
          <th>exit cost (unroll + sweep)</th>
          <th>verdict</th>
          <th>op</th>
        </tr>
        ${renderExitRows(rows, args.nowSec, args.graceSec ?? 0)}
      </table>
      <p class="muted">
        Expiry is the hard deadline: once the ASP sweeps an expired batch the
        pre-signed proofs are unusable. Deep payment chains cost more to exit —
        settling (refresh) resets the chain and with it the exit price.
      </p>
      ${fundingPanel(
        { address: args.fundingAddress, balanceSat: args.fundingBalanceSat },
        aggregateNeededSat(rows),
        'to exit everything still exitable above',
      )}
      ${finalSendSection({
        dest: args.dest,
        summary: args.summary,
        sendInfo: args.sendInfo,
        fundingBalanceSat: args.fundingBalanceSat,
      })}
    `,
  })
}
