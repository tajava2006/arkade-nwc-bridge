import { html, type RawHtml } from '../../lib/html'
import { ChainTxType } from '@arkade-os/sdk'
import type { ExitStep, ExitStepper } from '../../exit/stepper'
import { layout } from './layout'

// Requirement 10 made visual: a vertical stepper for one vtxo. Broadcast
// steps (root→leaf) show state + vsize, then the CSV countdown, then the
// sweep. Icons and text are redundant channels so the state reads without
// relying on color.

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

function stepLine(step: ExitStep): RawHtml {
  if (step.kind === 'broadcast') {
    const vsize = step.vsize !== null ? html` · <span class="muted">${step.vsize} vB</span>` : html``
    const state =
      step.status === 'confirmed'
        ? 'confirmed'
        : step.status === 'mempool'
          ? 'in mempool — waiting for a block'
          : 'not broadcast yet'
    return html`<li>
      ${icon(step.status)} <strong>${TYPE_LABEL[step.txType] ?? 'tx'}</strong>
      <code>${short(step.txid)}</code>${vsize} — ${state}
    </li>`
  }
  if (step.kind === 'wait') {
    if (step.status === 'sweepable') {
      return html`<li>${icon(step.status)} <strong>CSV timelock elapsed</strong> — ready to sweep</li>`
    }
    if (step.status === 'running') {
      const unit = step.unit === 'blocks' ? 'blocks' : 'seconds'
      return html`<li>
        ${icon(step.status)} <strong>CSV wait</strong> — ${step.have}/${step.need} ${unit}
      </li>`
    }
    return html`<li>${icon(step.status)} <strong>CSV wait</strong> — starts once fully unrolled</li>`
  }
  // sweep
  if (step.status === 'done') {
    return html`<li>
      ${icon(step.status)} <strong>swept</strong> → <code>${step.destAddress ?? '—'}</code>
      ${step.sweepTxid ? html`<br /><span class="muted">tx <code>${short(step.sweepTxid)}</code></span>` : html``}
    </li>`
  }
  return html`<li>
    ${icon(step.status)} <strong>sweep</strong> → your onchain address
    ${step.status === 'sweepable' ? html` <span class="ok">(available now)</span>` : html``}
  </li>`
}

export function renderStepperFragment(stepper: ExitStepper): RawHtml {
  const doneCount = stepper.steps.filter(
    (s) => s.status === 'confirmed' || s.status === 'done',
  ).length
  return html`
    <p class="muted">
      ${doneCount}/${stepper.steps.length} steps complete · state:
      <strong>${stepper.op?.state ?? 'not started'}</strong>
      ${stepper.proofComplete ? html`` : html` · <span class="bad">proofs incomplete</span>`}
    </p>
    <ol style="list-style:none; padding-left:0; line-height:2;">
      ${stepper.steps.map(stepLine)}
    </ol>
  `
}

export function exitDetailView(args: {
  stepper: ExitStepper
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
      <p class="muted">
        Each broadcast is a zero-fee transaction paired with a CPFP child from
        your exit-fuel address. First unroll the chain to the blockchain, wait
        out the CSV timelock, then sweep to a plain address you alone control.
      </p>
    `,
  })
}
