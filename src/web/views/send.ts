import type { ExtendedVirtualCoin } from '@arkade-os/sdk'
import { html, raw, type RawHtml } from '../../lib/html'
import { layout } from './layout'
import type { OffboardRow } from '../../offboards'
import { isExpiringSoon, type VtxoBuckets } from '../../send'

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
        <td class="muted" title="${v.txid}:${v.vout}">${v.txid.slice(0, 8)}…:${v.vout}</td>
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
            <td class="muted">${new Date(r.created_at * 1000).toLocaleString()}</td>
            <td class="num">${fmtSats(r.amount_sat)}${r.is_max ? html` <span class="muted">(max)</span>` : ''}</td>
            <td><span class="pill ${stateClass(r.state)}">${r.state}</span></td>
            <td class="muted" title="${r.address}">${r.address.slice(0, 12)}…</td>
            <td class="muted">
              ${r.ark_txid ? html`<span title="${r.ark_txid}">${r.ark_txid.slice(0, 10)}…</span>` : ''}
              ${r.error ? html`<span title="${r.error}">${r.error.slice(0, 40)}</span>` : ''}
            </td>
          </tr>`,
      )}
    </table>`
}

export function sendView(args: {
  buckets: VtxoBuckets
  arkSendMaxSat: number
  offboardMaxSat: number | null
  offboards: OffboardRow[]
  error?: string
}): RawHtml {
  const offboardMaxAttr = args.offboardMaxSat ?? 0
  return layout({
    title: 'Send',
    current: 'send',
    body: html`
      ${args.error ? html`<p class="pill failed" style="display:inline-block">${args.error}</p>` : ''}

      <form method="post" action="/send" data-send-form
            data-ark-max="${args.arkSendMaxSat}"
            data-offboard-max="${offboardMaxAttr}">
        <label>
          Destination
          <input type="text" name="destination" placeholder="bolt11 invoice · Ark address · onchain address"
                 autocomplete="off" required data-destination />
        </label>
        <p class="muted" data-rail-hint>Paste an invoice, Ark address, or onchain address.</p>
        <label data-amount-row>
          Amount (sats)
          <input type="number" name="amount" min="1" step="1" inputmode="numeric" data-amount />
        </label>
        <input type="hidden" name="max" value="" data-max-flag />
        <p>
          <button type="button" data-max-btn style="display:none">Max</button>
          <span class="muted" data-fee-hint></span>
        </p>
        <button type="submit">Send</button>
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
      ${breakdownTable(args.buckets)}

      <h2>Onchain exits</h2>
      <div data-offboards>${renderOffboardsFragment(args.offboards)}</div>

      ${raw(SEND_SCRIPT)}
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
      <p><a href="/send">Back to send</a> · <a href="/history">History</a></p>
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
        This waits for a settlement round to commit — it can take several minutes. Balance and
        History update live once the round finalizes.
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
  var offboardMax = parseInt(form.getAttribute('data-offboard-max') || '0', 10);
  function rail(v) {
    var s = (v || '').trim().toLowerCase();
    if (!s) return null;
    if (s.indexOf('ln') === 0) return 'lightning';
    if (s.indexOf('ark1') === 0 || s.indexOf('tark1') === 0) return 'ark';
    return 'onchain';
  }
  function update() {
    var r = rail(dest.value);
    if (r === 'lightning') {
      amountRow.style.display = 'none';
      amount.required = false;
      maxBtn.style.display = 'none';
      railHint.textContent = 'Lightning — amount is taken from the invoice. No max (drain not possible over LN).';
      feeHint.textContent = '';
      return;
    }
    amountRow.style.display = '';
    amount.required = true;
    if (r === 'ark') {
      maxBtn.style.display = arkMax > 0 ? '' : 'none';
      maxBtn.dataset.fill = String(arkMax);
      railHint.textContent = 'Ark offchain send — instant, free. Sub-dust/swept funds are not included.';
      feeHint.textContent = '';
    } else if (r === 'onchain') {
      maxBtn.style.display = offboardMax > 0 ? '' : 'none';
      maxBtn.dataset.fill = String(offboardMax);
      railHint.textContent = 'Onchain — collaborative offboard (one settlement round, ~minutes). Includes sub-dust/swept.';
      feeHint.textContent = offboardMax > 0 ? 'Max sweeps everything minus the intent fee.' : 'Total minus fee is below dust — cannot offboard.';
    } else {
      maxBtn.style.display = 'none';
      railHint.textContent = 'Paste an invoice, Ark address, or onchain address.';
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
