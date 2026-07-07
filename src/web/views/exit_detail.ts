import { html, raw, type RawHtml } from '../../lib/html'
import { ChainTxType } from '@arkade-os/sdk'
import type { ExitStep, ExitStepper } from '../../exit/stepper'
import type { ExitEstimate } from '../../exit/estimate'
import { qrSvg } from '../qr'
import { layout } from './layout'

export interface FundingStatus {
  address: string
  balanceSat: number | null
}

// Per-vtxo action + funding panel (EXIT_PLAN #14). Actions are per-vtxo only
// (§1: no bulk exit). Full cost sits visibly next to the button; the confirm
// dialog is a short irreversibility gate. The funding panel warns when the
// exit-fuel address can't cover the CPFP fees the unroll will need.
function actionPanel(s: ExitStepper, est: ExitEstimate | null): RawHtml {
  const op = s.op
  if (op?.state === 'swept') {
    return html`<p class="ok">Swept to <code>${op.destAddress ?? '—'}</code>. This vtxo has left Ark.</p>`
  }

  const costLine = est
    ? html`<p>Exit cost: <strong>${est.packages} transactions + sweep</strong>,
        ${est.totalVb.toLocaleString()} vB, about
        <strong>${est.totalFeeSat.toLocaleString()} sats</strong> in fees at
        ${est.feeRateSatVb} sat/vB
        (${Number.isFinite(est.feePctOfValue) ? est.feePctOfValue + '%' : '∞'} of value).</p>`
    : html``
  const uneconomical = est?.uneconomical
    ? html`<p class="bad">Fees meet or exceed this vtxo's value — exiting loses money.
        Only proceed if you need the funds out regardless.</p>`
    : html``

  const canStart = !op || op.state === 'failed'
  const startBtn = canStart
    ? html`<form method="post" action="/exit/${s.txid}/${s.vout}/start"
            onsubmit="return confirm('Start unilateral exit? This broadcasts the pre-signed chain and cannot be undone once the first transaction confirms.');">
          <button type="submit"${s.proofComplete ? raw('') : raw(' disabled')}>
            ${op?.state === 'failed' ? 'Retry exit' : 'Start exit'}
          </button>
          ${s.proofComplete
            ? html``
            : html`<span class="muted"> — proofs incomplete, cannot exit yet</span>`}
        </form>
        ${op?.state === 'failed' && op.error
          ? html`<p class="muted">Last error: ${op.error}</p>`
          : html``}`
    : html``

  const runningNote =
    op?.state === 'unrolling' || op?.state === 'waiting'
      ? html`<p class="muted">In progress — ${op.state === 'unrolling' ? 'broadcasting the pre-signed chain' : 'waiting out the CSV timelock'}.
          Safe to leave; it resumes across restarts.</p>`
      : html``

  const sweepBtn =
    op?.state === 'sweepable'
      ? html`<form method="post" action="/exit/${s.txid}/${s.vout}/sweep"
              onsubmit="return confirm('Sweep to your onchain address? The CSV timelock has elapsed; this spends the vtxo to a plain address you alone control.');">
            <button type="submit">Sweep now → your address</button>
          </form>`
      : html``

  return html`${costLine}${uneconomical}${startBtn}${runningNote}${sweepBtn}`
}

function fundingPanel(funding: FundingStatus, est: ExitEstimate | null): RawHtml {
  const bal = funding.balanceSat
  const needed = est ? est.totalFeeSat : null
  const low =
    bal !== null && needed !== null && bal < needed
      ? html`<p class="bad">Exit fuel is low: ${bal.toLocaleString()} sats on hand, about
          ${needed.toLocaleString()} needed for CPFP fees. Top it up before starting,
          or the unroll stalls unconfirmed.</p>`
      : html``
  return html`
    <h2>Exit fuel (onchain)</h2>
    ${low}
    <div class="receive-card">
      <div class="qr-box">${raw(qrSvg(funding.address))}</div>
      <pre>${funding.address}</pre>
      <p class="muted">
        Balance:
        ${bal === null
          ? html`<span class="muted">unknown (esplora unreachable)</span>`
          : html`<strong>${bal.toLocaleString()} sats</strong>`}.
        Each zero-fee exit transaction is CPFP-bumped from here (same nsec as
        the wallet — no extra backup). This is also the default sweep destination.
      </p>
    </div>
  `
}

// Requirement 10 made visual: the pre-signed chain drawn as the DAG it is —
// commitments (already onchain) across the top, spend edges downward, the
// vtxo's own tx at the bottom — then the CSV countdown and the sweep as a
// short list underneath. Icons and text are redundant channels so the state
// reads without relying on color.

function icon(status: string): string {
  switch (status) {
    case 'confirmed':
    case 'done':
      return '✅'
    case 'mempool':
      return '🕐'
    case 'running':
      return '⏳'
    case 'sweepable':
      return '🟢'
    default:
      return '⬜'
  }
}

function short(txid: string): string {
  return `${txid.slice(0, 10)}…${txid.slice(-8)}`
}

const TYPE_LABEL: Record<string, string> = {
  [ChainTxType.COMMITMENT]: 'commitment (onchain root)',
  [ChainTxType.TREE]: 'tree',
  [ChainTxType.CHECKPOINT]: 'checkpoint',
  [ChainTxType.ARK]: 'ark',
  [ChainTxType.UNSPECIFIED]: 'tx',
}

// Exported for the per-step status endpoint: a probe result re-renders the
// exact node the initial page carried, so the client only swaps elements by
// their data-step key — no client-side templating. Broadcast steps are DAG
// node cards; wait/sweep stay list items below the graph.
export function stepLine(step: ExitStep): RawHtml {
  if (step.kind === 'broadcast') {
    const vsize = step.vsize !== null ? html` · <span class="muted">${step.vsize} vB</span>` : html``
    const state =
      step.status === 'confirmed'
        ? 'confirmed'
        : step.status === 'mempool'
          ? 'in mempool — waiting for a block'
          : 'not broadcast yet'
    return html`<div class="dag-node" data-step="${step.txid}">
      ${icon(step.status)} <strong>${TYPE_LABEL[step.txType] ?? 'tx'}</strong>
      <code>${short(step.txid)}</code>${vsize}<br />
      <span class="muted">${state}</span>
    </div>`
  }
  if (step.kind === 'wait') {
    if (step.status === 'sweepable') {
      return html`<li data-step="wait">${icon(step.status)} <strong>CSV timelock elapsed</strong> — ready to sweep</li>`
    }
    if (step.status === 'running') {
      const unit = step.unit === 'blocks' ? 'blocks' : 'seconds'
      return html`<li data-step="wait">
        ${icon(step.status)} <strong>CSV wait</strong> — ${step.have ?? '…'}/${step.need} ${unit}
      </li>`
    }
    return html`<li data-step="wait">${icon(step.status)} <strong>CSV wait</strong> — starts once fully unrolled</li>`
  }
  // sweep
  if (step.status === 'done') {
    return html`<li data-step="sweep">
      ${icon(step.status)} <strong>swept</strong> → <code>${step.destAddress ?? '—'}</code>
      ${step.sweepTxid ? html`<br /><span class="muted">tx <code>${short(step.sweepTxid)}</code></span>` : html``}
    </li>`
  }
  return html`<li data-step="sweep">
    ${icon(step.status)} <strong>sweep</strong> → your onchain address
    ${step.status === 'sweepable' ? html` <span class="ok">(available now)</span>` : html``}
  </li>`
}

export function renderStepperFragment(stepper: ExitStepper): RawHtml {
  const broadcasts = stepper.levels.flat()
  const all = [...broadcasts, stepper.wait, stepper.sweep]
  const doneCount = all.filter((s) => s.status === 'confirmed' || s.status === 'done').length
  return html`
    <p class="muted">
      ${doneCount}/${all.length} steps complete · state:
      <strong>${stepper.op?.state ?? 'not started'}</strong>
      ${stepper.proofComplete ? html`` : html` · <span class="bad">proofs incomplete</span>`}
    </p>
    <div class="dag" data-dag>
      <svg class="dag-edges" aria-hidden="true"></svg>
      ${stepper.levels.map(
        (level) => html`<div class="dag-row">${level.map(stepLine)}</div>`,
      )}
    </div>
    <ol style="list-style:none; padding-left:0; line-height:2;">
      ${stepLine(stepper.wait)}${stepLine(stepper.sweep)}
    </ol>
  `
}

// Spend edges drawn client-side: node positions only exist after layout, so
// the server ships the edge list and ~20 lines of JS connect the boxes.
// Redraws on resize and after every probe swap (status text changes node
// geometry).
function dagScript(s: ExitStepper): RawHtml {
  const pairs = s.edges.map((e) => [e.parent, e.child])
  return html`<script>
    ;(function () {
      var edges = ${raw(JSON.stringify(pairs))}
      function draw() {
        var dag = document.querySelector('[data-dag]')
        var svg = dag ? dag.querySelector('.dag-edges') : null
        if (!dag || !svg) return
        var box = dag.getBoundingClientRect()
        svg.setAttribute('width', box.width)
        svg.setAttribute('height', box.height)
        var out = ''
        for (var i = 0; i < edges.length; i++) {
          var p = dag.querySelector('[data-step="' + edges[i][0] + '"]')
          var c = dag.querySelector('[data-step="' + edges[i][1] + '"]')
          if (!p || !c) continue
          var pb = p.getBoundingClientRect()
          var cb = c.getBoundingClientRect()
          out +=
            '<line x1="' + (pb.left + pb.width / 2 - box.left) +
            '" y1="' + (pb.bottom - box.top) +
            '" x2="' + (cb.left + cb.width / 2 - box.left) +
            '" y2="' + (cb.top - box.top) + '"></line>'
        }
        svg.innerHTML = out
      }
      draw()
      window.addEventListener('resize', draw)
      window.__drawDag = draw
    })()
  </script>`
}

// Onchain statuses arrive after render — the initial page is DB-only so a
// 100+ entry chain can't stall it. Steps are probed one at a time in the
// engine's broadcast order and the first non-confirmed answer ends the scan:
// nothing past that point can be onchain. Nodes keep their server-rendered
// "not broadcast yet" default; only probed nodes get swapped.
function statusFillIn(s: ExitStepper): RawHtml {
  if (s.probe.length === 0) return html``
  return html`
    <p class="muted" data-probe-note>checking onchain status…</p>
    <script>
      ;(function () {
        var probe = ${raw(JSON.stringify(s.probe))}
        var base = '/exit/${s.txid}/${s.vout}/step/'
        var note = document.querySelector('[data-probe-note]')
        var i = 0
        function set(msg) {
          if (note) note.textContent = msg
        }
        function swap(key, markup) {
          if (!markup) return
          var el = document.querySelector('[data-step="' + key + '"]')
          if (el) el.outerHTML = markup
        }
        function next() {
          if (i >= probe.length) {
            set('')
            return
          }
          set('checking onchain status… ' + (i + 1) + '/' + probe.length)
          fetch(base + probe[i])
            .then(function (r) {
              if (!r.ok) throw new Error('status ' + r.status)
              return r.json()
            })
            .then(function (d) {
              swap(probe[i], d.stepHtml)
              swap('wait', d.waitHtml)
              swap('sweep', d.sweepHtml)
              if (window.__drawDag) window.__drawDag()
              i = i + 1
              if (d.status === 'confirmed') next()
              else set('')
            })
            .catch(function () {
              set('onchain status check unavailable — showing last known state')
            })
        }
        next()
      })()
    </script>
  `
}

/** Shown when a sweep is rejected (CSV not elapsed, dust, etc.) — a plain page with the reason. */
export function exitSweepError(txid: string, vout: number, reason: string): RawHtml {
  return layout({
    title: 'Sweep failed',
    current: 'exit',
    body: html`
      <p><a href="/exit/${txid}/${vout}">← back</a></p>
      <p class="bad">Sweep failed: ${reason}</p>
    `,
  })
}

export function exitDetailView(args: {
  stepper: ExitStepper
  estimate: ExitEstimate | null
  funding: FundingStatus
  degraded: boolean
}): RawHtml {
  const s = args.stepper
  return layout({
    title: `Exit ${s.txid.slice(0, 8)}…:${s.vout}`,
    current: 'exit',
    body: html`
      <p><a href="/exit">← all vtxos</a></p>
      ${args.degraded
        ? html`<p class="bad">Degraded mode — computed from the local vault and esplora only.</p>`
        : html``}
      <p><strong>${s.valueSat.toLocaleString()} sats</strong> · <code>${s.txid}:${s.vout}</code></p>
      <div data-exit-stepper="${s.txid}:${s.vout}">${renderStepperFragment(s)}</div>
      ${dagScript(s)}
      ${statusFillIn(s)}

      <h2>Action</h2>
      ${actionPanel(s, args.estimate)}

      ${fundingPanel(args.funding, args.estimate)}

      <p class="muted">
        Each broadcast is a zero-fee transaction paired with a CPFP child from
        your exit-fuel address. First unroll the chain to the blockchain, wait
        out the CSV timelock, then sweep to a plain address you alone control.
      </p>
    `,
  })
}
