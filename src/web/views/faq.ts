import { html, type RawHtml } from '../../lib/html'
import { layout } from './layout'
import { RENEW_WINDOW_LABEL } from './send'

// Plain-language answers to the questions a user should ask before trusting
// an Ark wallet with money. The rule of the page: where a guarantee has a
// sharp edge, the edge is stated — a self-custody claim that rounds up is
// worth less than no claim at all. Deep dives live in the design docs
// (EXIT_DESIGN.md, ATOMIC_SUBDUST_PLAN.md); this page is the honest summary.

export function faqView(): RawHtml {
  return layout({
    title: 'FAQ',
    current: 'faq',
    body: html`
      <h2>Is this wallet 100% self-custodial?</h2>
      <p>On a Bitcoin L2 that claim splits into two separate questions.</p>
      <p>
        <strong>Can I always escape to onchain L1 without anyone's help?</strong> Yes.
        Ark guarantees this at the protocol level — every VTXO carries a pre-signed
        unilateral exit chain that needs nobody's cooperation to broadcast — and this
        app makes the guarantee usable: the <a href="/exit">Exit tab</a> keeps those
        proofs mirrored locally and works even with the server dead. Two conditions,
        both watched on the dashboard: the proofs must be synced (the
        <em>Exit readiness</em> tile), and the exit must happen before the VTXO's
        expiry.
      </p>
      <p>
        <strong>Am I the only one who can spend it?</strong> Almost — with one edge
        worth knowing. A VTXO you <em>received</em> offchain could in theory be
        double-spent if the Ark server and the VTXO's previous owner colluded. That
        window closes at the next settlement round: a refresh anchors the VTXO
        onchain and makes it unconditionally yours. So received funds are, strictly
        speaking, not 100% yours until the next refresh — refresh after receiving and
        the answer becomes an unqualified yes. (Change from your own sends is safe
        either way: the "previous owner" is you.) Sub-dust amounts have their own
        caveat — see the sub-dust question below.
      </p>

      <h2>What is a refresh?</h2>
      <p>
        A settlement round that resets a VTXO's expiry clock and — as above — makes
        ownership unconditionally yours, committed onchain. The server pays the
        round's onchain fee; it costs you nothing. You rarely trigger it by hand:
        while the bridge is running, the moment any VTXO comes within
        ${RENEW_WINDOW_LABEL} of expiry, <em>all</em> VTXOs are automatically folded
        into one fresh VTXO — fewer rounds for the server, one defragmented VTXO
        with a full expiry reset for you. The manual button and the details are on
        the <a href="/send">Send tab</a>.
      </p>

      <h2>What are the fees?</h2>
      <p>
        Money coming <strong>in</strong> is free: a Lightning receive carries no swap
        fee (the invoiced amount lands in full; the sender pays their own routing),
        and an onchain deposit has nothing deducted on conversion (you only pay the
        mining fee of your own deposit transaction). Moving <strong>within</strong>
        Ark is free — offchain sends and refreshes cost nothing. Money going
        <strong>out</strong> is charged: onchain withdrawals pay a flat withdraw fee,
        Lightning sends a percentage swap fee. The live numbers are always shown
        before you confirm on the <a href="/send">Send tab</a>.
      </p>

      <h2>Are deposits and withdrawals atomic?</h2>
      <p>
        Lightning, both directions, runs on the Boltz swap protocol: trustless and
        atomic. If the counterparty takes one side and fails to deliver the other,
        the script guarantees a refund after a timeout — nobody can end up holding
        both sides. Onchain deposits are protected by a timelock of their own: if a
        deposit is never converted into a VTXO, you reclaim it unilaterally onchain
        once the timelock expires. Onchain withdrawals happen inside a settlement
        round — you give up the VTXO only in the same transaction that creates your
        onchain output.
      </p>

      <h2>Other Ark wallets can't swap under 330 sats. This one can — is it really atomic?</h2>
      <p>
        <strong>Why others can't:</strong> Bitcoin has a dust floor — an output below
        330 sats can't stand on its own onchain, and Ark inherits that limit because
        every offchain claim must be backed by a real onchain output. The standard
        swap construction holds the amount in an HTLC <em>output</em>, which simply
        cannot exist below dust, so official infrastructure sets ~330-sat minimums.
      </p>
      <p>
        <strong>How this one does:</strong> the amount is never an output. The swap
        funds one shared VTXO of normal size and pre-signs two split states of it —
        the amount is the <em>delta</em> between them. Revealing the Lightning
        preimage is the act that executes the pre-signed split, so a 1-sat payment
        rides on a normal-sized commitment without ever being a dust output.
      </p>
      <p>
        <strong>Is it atomic?</strong> Yes, in the exact swap sense: the funder
        cannot lose the funding without the preimage being revealed (full refund
        after the timeout, unilateral exit underneath), and the claimer can only get
        paid by revealing the preimage — the same act that settles the Lightning
        side. Verified live on mainnet in both directions. One honest caveat: the
        sub-dust piece the winner ends up with is a standard Ark
        <em>recoverable</em> VTXO — its onchain claim is below dust, so turning it
        into spendable money relies on ASP cooperation (the next refresh folds it
        in). That limitation is bounded by the amount itself (&lt; 330 sats) and is
        inherent to sub-dust on any Ark, not to this swap.
      </p>

      <h2>I used the same key in another wallet — do the exit proofs stay correct?</h2>
      <p>
        Yes. The bridge continuously mirrors every VTXO's pre-signed exit proofs
        while the server is reachable, and it never takes the server's word for a
        deletion. A VTXO that disappears from the server's list is removed from the
        local vault only with evidence: a spend actually signed by <em>your</em> key
        (a spend made from another wallet holding the same key verifies identically —
        no false alarms), an expiry passed by the local clock, or a completed exit of
        our own. Anything else is <strong>quarantined</strong> — proofs kept, still
        exitable until expiry, flagged loudly on the dashboard and the
        <a href="/exit">Exit tab</a>. The reverse direction is watched too: if the
        server credits you a VTXO but withholds its proofs, the <em>Exit
        readiness</em> tile shows proven &lt; claimed as a red warning.
      </p>

      <h2>What do I need to back up?</h2>
      <p>
        One secret: the nsec. It is both the wallet key (all VTXOs, the boarding
        address, the exit fuel) and the Nostr identity (NWC connections, the
        noffer). <code>bun run show-nsec</code> prints it;
        <code>bun run show-btc-key</code> prints the same key as WIF + descriptor
        for import into any descriptor wallet — the funds never depend on this
        bridge existing.
      </p>

      <h2>What if the Ark server goes down — or disappears for good?</h2>
      <p>
        The bridge still boots (degraded mode) from its local vault and public
        esplora alone, and the <a href="/exit">Exit tab</a> works fully: unroll the
        pre-signed chains, wait out the timelock, sweep to an address you control.
        The clock that matters is each VTXO's expiry — exit before it. That is why
        <em>Exit readiness</em> lives on the dashboard rather than buried in a menu.
      </p>

      <h2>What is "sub-dust"?</h2>
      <p>
        Amounts below 330 sats — the dust floor for this output type. They can't be
        standalone onchain outputs, so on Ark they exist as <em>recoverable</em>
        VTXOs: really yours, but not spendable offchain on their own, with
        ASP-cooperative rather than unilateral enforcement. They fold back into your
        spendable balance at the next refresh (automatic) or ride out with an
        onchain withdrawal — never lost, just parked. The upside of supporting them
        at all: 1-sat zaps work here, which is what the atomic-swap question above
        exists to make honest.
      </p>

      <h2>Do I need to keep the bridge running?</h2>
      <p>
        Mostly yes — it's a small server, not a phone app. While it runs, refreshes
        are automatic and nothing expires. If it stays down long enough for a VTXO's
        expiry to pass, the server is entitled to sweep those funds — and past expiry
        even the unilateral exit proofs are dead paper. Expiry windows are measured
        in weeks (each VTXO's countdown is on the <a href="/send">Send tab</a>), so
        "keep it running, check in now and then" is the whole operational burden.
      </p>
    `,
  })
}
