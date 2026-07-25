import type { ArkInfo, ExtendedVirtualCoin } from '@arkade-os/sdk'
import type { FeesResponse } from '@arkade-os/boltz-swap'
import { html, raw, type RawHtml } from '../../lib/html'
import { layout } from './layout'
import { copyable, localTime } from './ui'
import type { OffboardRow } from '../../offboards'
import {
  classifyVtxos,
  isExpiringSoon,
  lnDrainInvoiceSat,
  offboardFeeSat,
  offboardMaxSat,
  type SendData,
  type VtxoBuckets,
} from '../../send'

function fmtSats(n: number): string {
  return `${n.toLocaleString()} sats`
}

function expiryHint(v: ExtendedVirtualCoin): RawHtml {
  const expiry = v.virtualStatus.batchExpiry
  if (!expiry) return html`<span class="muted">—</span>`
  const ms = expiry - Date.now()
  if (ms <= 0) return html`<span class="muted">expired</span>`
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  const label = days > 0 ? `${days}d ${hours}h` : `${hours}h`
  return isExpiringSoon(v)
    ? html`<span class="pill pending">${label}</span>`
    : html`<span class="muted">${label}</span>`
}

function vtxoRows(vtxos: ExtendedVirtualCoin[], tag: RawHtml): RawHtml {
  return html`${vtxos.map(
    (v) => html`
      <tr>
        <td class="num">${fmtSats(v.value)}</td>
        <td>${tag}</td>
        <td>${expiryHint(v)}</td>
        <td class="muted">${copyable(`${v.txid}:${v.vout}`, `${v.txid.slice(0, 8)}…:${v.vout}`)}</td>
      </tr>`,
  )}`
}

/** VTXO breakdown table (SEND_DESIGN.md §7). Three rail-aware buckets. */
function breakdownTable(buckets: VtxoBuckets): RawHtml {
  const total = buckets.spendable.length + buckets.subdust.length + buckets.recoverable.length
  if (total === 0) {
    return html`<p class="muted">No VTXOs.</p>`
  }
  return html`
    <table>
      <tr><th class="num">Value</th><th>Bucket</th><th>Expiry</th><th>VTXO</th></tr>
      ${vtxoRows(buckets.spendable, html`<span class="pill settled">spendable</span>`)}
      ${vtxoRows(buckets.subdust, html`<span class="pill preconfirmed">sub-dust</span>`)}
      ${vtxoRows(buckets.recoverable, html`<span class="pill preconfirmed">swept/expired</span>`)}
    </table>
    <p class="muted" style="margin-top:0.8em">
      Offchain-spendable <strong>${fmtSats(buckets.spendableSat)}</strong>
      · recoverable via round <strong>${fmtSats(buckets.subdustSat + buckets.recoverableSat)}</strong>
      · total <strong>${fmtSats(buckets.roundTotalSat)}</strong>
    </p>
    <p class="muted">
      "Recoverable via round" (sub-dust + swept/expired) can't be spent by Ark/LN send —
      only an onchain offboard or Refresh consolidates it back into spendable funds. It is
      not lost.
    </p>`
}

function stateClass(state: OffboardRow['state']): string {
  return state === 'settled' ? 'settled' : state === 'failed' ? 'failed' : 'pending'
}

/**
 * Recent offboards table. Exported so the SSE channel can swap just this region
 * into [data-offboards] when a pending exit settles or fails.
 */
export function renderOffboardsFragment(rows: OffboardRow[]): RawHtml {
  if (rows.length === 0) {
    return html`<p class="muted">No onchain exits yet.</p>`
  }
  return html`
    <table>
      <tr>
        <th>When</th>
        <th class="num">Amount</th>
        <th>State</th>
        <th>Destination</th>
        <th>Txid / error</th>
      </tr>
      ${rows.map(
        (r) => html`
          <tr>
            <td class="muted">${localTime(r.created_at * 1000)}</td>
            <td class="num">${fmtSats(r.amount_sat)}${r.is_max ? html` <span class="muted">(max)</span>` : ''}</td>
            <td><span class="pill ${stateClass(r.state)}">${r.state}</span></td>
            <td class="muted">${copyable(r.address, `${r.address.slice(0, 12)}…`)}</td>
            <td class="muted">
              ${r.ark_txid ? copyable(r.ark_txid, `${r.ark_txid.slice(0, 10)}…`) : ''}
              ${r.error ? html`<span title="${r.error}">${r.error.slice(0, 40)}</span>` : ''}
            </td>
          </tr>`,
      )}
    </table>`
}

/**
 * Standing "how do I empty this wallet" guidance, independent of the Max
 * button. Onchain: the offboard rail is the one path that always works — a
 * settlement round consumes sub-dust and swept/expired VTXOs directly, no
 * Refresh needed. Lightning: the drain works by making the invoice amount
 * fit the balance (lnDrainInvoiceSat) and needs a Refresh first whenever
 * sub-dust/swept funds exist, since those can't back an offchain send.
 * Amounts are computed from arkInfo + the boltz fee table, never hardcoded:
 * either fee config can change without this copy going stale.
 */
function drainHint(arkInfo: ArkInfo, fees: FeesResponse, buckets: VtxoBuckets): RawHtml {
  if (buckets.roundTotalSat === 0) return html``
  const fee = offboardFeeSat(arkInfo, buckets.roundTotalSat)
  const dust = Number(arkInfo.dust)
  const max = offboardMaxSat(arkInfo, buckets)
  const onchain =
    max === null
      ? html`
          <p class="muted">
            <strong>Emptying the wallet — onchain:</strong> not possible right now — total
            ${fmtSats(buckets.roundTotalSat)} minus the intent fee (${fmtSats(fee)}) is below
            dust (${fmtSats(dust)}), so no valid onchain output can be made. Top the wallet up
            first, then sweep.
          </p>`
      : html`
          <p class="muted">
            <strong>Emptying the wallet — onchain:</strong> an offboard (Max) always works — it
            sweeps every VTXO including sub-dust and swept/expired, no Refresh needed, and the
            destination receives <strong>${fmtSats(max)}</strong> (total
            ${fmtSats(buckets.roundTotalSat)} − intent fee ${fmtSats(fee)}). A <em>partial</em>
            onchain send must leave either nothing or at least ${fmtSats(dust)} behind — change
            of 1–${(dust - 1).toLocaleString()} sats is rejected before anything moves.
          </p>`

  // LN drain targets the full balance (Refresh is a free round, so the total
  // is unchanged by it — the same invoice amount stays valid before/after).
  const lnInvoice = lnDrainInvoiceSat(fees, buckets.roundTotalSat)
  const needsRefresh = buckets.subdustSat + buckets.recoverableSat > 0
  const ln =
    lnInvoice === null
      ? html``
      : needsRefresh
        ? html`
            <p class="muted">
              <strong>Emptying the wallet — Lightning:</strong> hit Refresh first (free, the
              total doesn't change), then pay a self-made invoice of exactly
              <strong>${fmtSats(lnInvoice)}</strong>. Sub-dust/swept funds can't back an LN
              send, so skipping the Refresh just fails cleanly before anything moves.
            </p>`
        : html`
            <p class="muted">
              <strong>Emptying the wallet — Lightning:</strong> pay a self-made invoice of
              exactly <strong>${fmtSats(lnInvoice)}</strong> — the bridge funds the swap with
              the entire balance, so nothing is left behind (a rounding residue of up to 2 sats
              is folded into the swap fee instead of stranding as sub-dust).
            </p>`

  return html`${onchain}${ln}`
}

/**
 * Inner content of the [data-breakdown] slot. Rendered from the SWR snapshot
 * at page load and swapped in via SSE when the send-data cache refreshes — the
 * whole table is replaced (no diffing the VTXO set). `null` = first load before
 * the cache is warm.
 */
export function renderBreakdownFragment(value: SendData | null): RawHtml {
  if (!value) return html`<p class="muted">Loading…</p>`
  const buckets = classifyVtxos(value.vtxos, value.arkInfo.dust)
  return html`${breakdownTable(buckets)}${drainHint(value.arkInfo, value.fees, buckets)}`
}

export function sendView(args: {
  value: SendData | null
  offboards: OffboardRow[]
  error?: string
}): RawHtml {
  const buckets = args.value ? classifyVtxos(args.value.vtxos, args.value.arkInfo.dust) : null
  // Max exists to *empty* the wallet. An Ark-send "max" of just the spendable
  // bucket would leave sub-dust/swept behind — worse for the user than no
  // button (the leftovers are the annoying part to deal with later) — so the
  // button is offered only when there's nothing it would strand. The leftover
  // total is passed separately so the hint can say why Max is missing.
  const arkLeftoverSat = buckets ? buckets.subdustSat + buckets.recoverableSat : 0
  const arkSendMaxSat = buckets && arkLeftoverSat === 0 ? buckets.spendableSat : 0
  const offboardMax = args.value && buckets ? offboardMaxSat(args.value.arkInfo, buckets) : null
  const offboardMaxAttr = offboardMax ?? 0
  return layout({
    title: 'Send',
    current: 'send',
    body: html`
      ${args.error ? html`<p class="pill failed" style="display:inline-block">${args.error}</p>` : ''}

      <form method="post" action="/send" data-send-form
            data-ark-max="${arkSendMaxSat}"
            data-ark-leftover="${arkLeftoverSat}"
            data-offboard-max="${offboardMaxAttr}">
        <label>
          Destination
          <input type="text" name="destination" placeholder="bolt11 · noffer · Ark address · onchain address"
                 autocomplete="off" required data-destination />
        </label>
        <p class="muted" data-rail-hint>Paste an invoice, noffer, Ark address, or onchain address.</p>
        <label data-amount-row>
          Amount (sats)
          <input type="number" name="amount" min="1" step="1" inputmode="numeric" data-amount />
        </label>
        <input type="hidden" name="max" value="" data-max-flag />
        <p>
          <button type="button" data-max-btn style="display:none">Max</button>
          <span class="muted" data-fee-hint></span>
        </p>
        <button type="submit">Review</button>
      </form>

      <h2>Refresh</h2>
      <p class="muted">
        Consolidate <strong>every</strong> VTXO (incl. sub-dust + swept) into one fresh VTXO,
        resetting the expiry clock. This is the only way to make sub-dust/swept funds
        offchain-spendable again without going onchain. No options — it always folds everything.
      </p>
      <form method="post" action="/refresh" onsubmit="return confirm('Consolidate all VTXOs into one fresh VTXO?')">
        <button type="submit">Refresh all</button>
      </form>

      <h2>Balance breakdown</h2>
      <div data-breakdown>${renderBreakdownFragment(args.value)}</div>

      <h2>Onchain exits</h2>
      <div data-offboards>${renderOffboardsFragment(args.offboards)}</div>

      ${raw(SEND_SCRIPT)}
    `,
  })
}

/**
 * Review/confirm step before any funds move. Shows the parsed destination,
 * amount, fee, and total leaving the wallet; the confirm button re-posts the
 * same params to /send/confirm where the rail actually executes.
 */
export function sendConfirmView(args: {
  title: string
  destination: string
  amountField: string
  isMax: boolean
  rows: { label: string; value: string }[]
  note?: string
}): RawHtml {
  return layout({
    title: 'Confirm send',
    current: 'send',
    body: html`
      <h2>${args.title}</h2>
      <table>
        ${args.rows.map(
          (r) => html`<tr><th style="width:14em">${r.label}</th><td class="num">${r.value}</td></tr>`,
        )}
      </table>
      ${args.note ? html`<p class="muted">${args.note}</p>` : ''}
      <form method="post" action="/send/confirm">
        <input type="hidden" name="destination" value="${args.destination}" />
        <input type="hidden" name="amount" value="${args.amountField}" />
        <input type="hidden" name="max" value="${args.isMax ? '1' : ''}" />
        <p>
          <button type="submit">Confirm &amp; send</button>
          <a href="/send" style="margin-left:1em">Cancel</a>
        </p>
      </form>
    `,
  })
}

/** Blocking result for Ark / LN sends (instant–seconds). */
export function sendResultView(args: {
  label: string
  ok: boolean
  detail: string
}): RawHtml {
  return layout({
    title: 'Send',
    current: 'send',
    body: html`
      <p class="pill ${args.ok ? 'settled' : 'failed'}" style="display:inline-block">
        ${args.ok ? 'Sent' : 'Failed'} · ${args.label}
      </p>
      <pre>${args.detail}</pre>
      <p><a href="/send">Back to send</a></p>
    `,
  })
}

/** Fire-and-forget acknowledgement for a long-running round (offboard / refresh). */
export function submittedView(args: { title: string; lines: RawHtml }): RawHtml {
  return layout({
    title: 'Send',
    current: 'send',
    body: html`
      <p class="pill pending" style="display:inline-block">${args.title}</p>
      ${args.lines}
      <p class="muted">
        This waits for a settlement round to commit — it can take several minutes. Balance
        updates live once the round finalizes.
      </p>
      <p><a href="/send">Back to send</a></p>
    `,
  })
}

// Client-side rail detection + Max button. Authoritative classification still
// happens server-side on submit (src/send.ts); this is only to show the right
// affordance as the operator types. Heuristic by prefix: lnbc/lntb = LN,
// ark1/tark1 = Ark, else onchain.
const SEND_SCRIPT = `<script>
(function () {
  var form = document.querySelector('[data-send-form]');
  if (!form) return;
  var dest = form.querySelector('[data-destination]');
  var amountRow = form.querySelector('[data-amount-row]');
  var amount = form.querySelector('[data-amount]');
  var maxBtn = form.querySelector('[data-max-btn]');
  var maxFlag = form.querySelector('[data-max-flag]');
  var railHint = form.querySelector('[data-rail-hint]');
  var feeHint = form.querySelector('[data-fee-hint]');
  var arkMax = parseInt(form.getAttribute('data-ark-max') || '0', 10);
  var arkLeftover = parseInt(form.getAttribute('data-ark-leftover') || '0', 10);
  var offboardMax = parseInt(form.getAttribute('data-offboard-max') || '0', 10);
  function rail(v) {
    var s = (v || '').trim().toLowerCase();
    if (!s) return null;
    if (s.indexOf('noffer1') === 0) return 'clink';
    if (s.indexOf('ln') === 0) return 'lightning';
    if (s.indexOf('ark1') === 0 || s.indexOf('tark1') === 0) return 'ark';
    return 'onchain';
  }
  // Parse the amount straight out of the bolt11 HRP so the operator sees what
  // they're paying the moment they paste — the amount field is hidden for LN
  // (it's fixed by the invoice), and we never want a blind "send". Authoritative
  // amount/fee still come from the server's decode on the review step.
  function bolt11Sats(v) {
    var m = /^ln(?:bc|tb|bcrt|sb)([0-9]+)([munp]?)1/i.exec((v || '').trim());
    if (!m) return null;
    var mult = { m: 1e5, u: 1e2, n: 0.1, p: 1e-4 }[m[2].toLowerCase()];
    if (mult === undefined) mult = 1e8; // no multiplier = whole BTC
    return Math.round(parseInt(m[1], 10) * mult * 1000) / 1000;
  }
  function update() {
    var r = rail(dest.value);
    if (r === 'lightning') {
      amountRow.style.display = 'none';
      amount.required = false;
      maxBtn.style.display = 'none';
      var sats = bolt11Sats(dest.value);
      railHint.textContent = sats != null
        ? 'Lightning — paying ' + sats.toLocaleString() + ' sats (fixed by the invoice). You will review before sending.'
        : 'Lightning — amount is taken from the invoice. You will review before sending.';
      feeHint.textContent = '';
      return;
    }
    if (r === 'clink') {
      amountRow.style.display = '';
      // Fixed-price offers need no amount; the server requires it otherwise.
      amount.required = false;
      maxBtn.style.display = 'none';
      railHint.textContent = 'CLINK offer (noffer) — enter an amount (required unless the offer is fixed-price). Resolved to a Lightning invoice.';
      feeHint.textContent = '';
      return;
    }
    amountRow.style.display = '';
    amount.required = true;
    if (r === 'ark') {
      // arkMax is 0 whenever sub-dust/swept exists (server-side gating): a
      // spendable-only "max" would strand those, betraying what Max is for.
      maxBtn.style.display = arkMax > 0 ? '' : 'none';
      maxBtn.dataset.fill = String(arkMax);
      railHint.textContent = 'Ark offchain send — instant, free. Sub-dust/swept funds are not included.';
      feeHint.textContent = arkLeftover > 0
        ? 'Max is disabled: ' + arkLeftover.toLocaleString() + ' sats of sub-dust/swept funds exist and an Ark send would strand them. Refresh first, or enter an amount to send spendable funds only.'
        : '';
    } else if (r === 'onchain') {
      maxBtn.style.display = offboardMax > 0 ? '' : 'none';
      maxBtn.dataset.fill = String(offboardMax);
      railHint.textContent = 'Onchain — collaborative offboard (one settlement round, ~minutes). Includes sub-dust/swept.';
      feeHint.textContent = offboardMax > 0 ? 'Max sweeps everything minus the intent fee.' : 'Total minus fee is below dust — cannot offboard.';
    } else {
      maxBtn.style.display = 'none';
      railHint.textContent = 'Paste an invoice, noffer, Ark address, or onchain address.';
      feeHint.textContent = '';
    }
  }
  // Editing the amount by hand clears the max flag — only the Max button (full
  // drain) sets it, because offboard MUST omit the amount for a true drain (a
  // numeric "max" would be treated as gross and leave a fee-sized change vtxo).
  amount.addEventListener('input', function () { maxFlag.value = ''; });
  dest.addEventListener('input', function () { maxFlag.value = ''; update(); });
  maxBtn.addEventListener('click', function () {
    if (maxBtn.dataset.fill) amount.value = maxBtn.dataset.fill;
    maxFlag.value = '1';
  });
  update();
})();
</script>`
