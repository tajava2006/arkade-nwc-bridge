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
        app makes the guarantee usable: while it runs, the <a href="/exit">Exit tab</a>
        keeps those proofs mirrored locally on its own, so the escape hatch works even
        with the server dead. This isn't a chore you have to tend — leave the bridge
        running and the <em>Exit readiness</em> tile on the dashboard just tells you the
        proofs are backed up. The one judgment call that is genuinely yours: if the
        server has truly vanished, exit <em>before</em> your VTXOs' expiry — past that
        the proofs are dead paper. But a server that briefly blipped offline is not a
        server that fled. If it's just down, wait for it to come back and move your
        money out with an ordinary onchain send from the <a href="/send">Send tab</a> —
        that is always far cheaper than a unilateral exit. Press the exit button only
        once you are convinced the server is gone for good.
      </p>
      <p>
        <strong>Am I the only one who can spend it?</strong> Almost — with one edge
        worth knowing. A VTXO you <em>received</em> offchain could in theory be
        double-spent if the Ark server and a <em>previous owner</em> colluded. And
        "previous owner" means the whole chain of custody back to the last time that
        VTXO was anchored onchain by a refresh — not just the person who handed it to
        you. That window closes at the next settlement round: a refresh anchors the
        VTXO onchain and makes it unconditionally yours. So received funds are,
        strictly speaking, not 100% yours until the next refresh.
      </p>
      <p>
        This is why a single refresh right after receiving buys full ownership for
        everything downstream. Once a refresh has made a VTXO unconditionally yours,
        spending it and taking the change back <em>looks</em> like it could still be
        double-spent — but trace the chain of previous owners and it stops at your own
        refresh, all of it you, so there's no one left to collude with. In practice: if
        your style is to receive a large amount now and then and spend it down, refresh
        once immediately after each receive and then just spend — from that point on
        everything is always fully yours. And as the server matures and refreshes can
        run far more often, that cryptographic finality will lock in almost the instant
        you receive. Sub-dust amounts have their own caveat — see the sub-dust question
        below.
      </p>

      <h2>What is a refresh?</h2>
      <p>
        An onchain settlement round that wipes a VTXO's history clean. It cuts the chain
        of previous owners described above — the very thing that leaves received funds
        theoretically double-spendable — and re-issues a brand-new VTXO bound to you and
        you alone, committed onchain. At the same time it resets the expiry clock. The
        server pays the
        round's onchain fee; it costs you nothing. You rarely trigger it by hand:
        while the bridge is running, the moment any VTXO comes within
        ${RENEW_WINDOW_LABEL} of expiry, <em>all</em> VTXOs are automatically folded
        into one fresh VTXO — fewer rounds for the server, one defragmented VTXO
        with a full expiry reset for you. The manual button and the details are on
        the <a href="/send">Send tab</a>.
      </p>

      <h2>If full ownership needs an onchain refresh, why use Ark at all?</h2>
      <p>
        Because a refresh isn't one onchain transaction per person. Lightning is the
        clean contrast: once a channel is open it gives you nearly unlimited scale
        <em>inside</em> it — but opening and closing that channel each burns block space
        in proportion to the number of people, and that block space is spent
        <em>exclusively</em> for that one participant. An Ark settlement round is a
        <em>shared</em> transaction: many people refresh together in it, and its onchain
        footprint stays essentially constant no matter how many join — the per-user VTXO
        tree and connectors live offchain, and only one small commitment lands on L1.
        Thousands could settle in the same fixed-size transaction. So in theory you can
        confirm your ownership without ever once consuming block space for yourself
        alone — you ride along in a round that was going to happen anyway. That is the
        whole scaling argument: the block space a Lightning-only world spends one pair at
        a time, Ark spends once for an entire round, so the number of self-custodial
        users a single block can serve is far higher.
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

      <h2>What is "sub-dust"?</h2>
      <p>
        Amounts below 330 sats — the dust floor for this output type. They can't be
        standalone onchain outputs, so on Ark they exist as <em>recoverable</em>
        VTXOs: really yours, but not spendable on their own until a refresh, with
        ASP-cooperative rather than unilateral enforcement. They fold back into your
        spendable balance at the next refresh (automatic) or ride out with an
        onchain withdrawal — never lost, just parked. The upside of supporting them
        at all: 1-sat zaps work here, which is what the atomic-swap question below
        exists to make honest.
      </p>

      <h2>Arkade can't swap under 330 sats. This one can — is it really atomic?</h2>
      <p>
        <strong>Why Arkade can't:</strong> A sub-dust output <em>can</em> still exist on
        Ark — that's the recoverable VTXO from the question above — you just can't use it
        until a refresh folds it in. A plain sub-dust send is therefore fine: it drops
        that recoverable VTXO straight onto the recipient's address, done. A <em>swap</em>
        is where it breaks. The standard construction routes the amount through an
        intermediate HTLC script address that the counterparty has to claim to complete
        the atomic exchange — but while that HTLC output is sub-dust, nobody can use it
        until a refresh, so the atomic step never closes. That's why Arkade's own swap
        path sets a ~330-sat minimum.
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
        side. Verified live on mainnet in both directions. One honest caveat, on the
        success path specifically: when the Lightning side settles and the claimer takes
        their share, that share is a sub-dust <em>recoverable</em> VTXO — so, like any
        sub-dust, it can't be used until the next refresh folds it in. Put plainly: the
        VTXO piece is exchanged <em>atomically</em>, but the piece you walk away holding
        has no unilateral-exit right of its own. (That's the success path only. If
        Lightning fails and the swap refunds, the funder gets their original
        dust-or-larger VTXO back intact — no sub-dust in the picture.) The limitation is
        bounded by the amount itself (&lt; 330 sats) and is inherent to sub-dust on any
        Ark, not to this swap.
      </p>

      <h2>But some Ark wallets do sub-dust swaps already — how?</h2>
      <p>
        Those aren't running arkd's design — that's <strong>bark</strong>, the
        implementation from the Second team, and the difference is a deliberate policy
        trade-off, not magic. Bark <em>never</em> merges VTXOs. Because inputs are never
        combined, a sub-dust VTXO's un-exitability can never leak into the exit rights
        of the VTXOs around it — each stays linearly isolated. So a sub-dust piece is
        free to move around on the premise that it simply has no unilateral-exit right,
        and that is what lets bark hand a sub-dust amount across a swap at all.
      </p>
      <p>
        One honest correction, because it's exactly this wallet's differentiator: bark's
        sub-dust swaps are <strong>not atomic</strong>. They're server-trusted — there's
        no pre-signed commitment underneath, so if a swap half-completes the server can
        end up sweeping the sub-dust HTLC. Receiving the piece works, and unilaterally
        exiting the piece you received is blocked — but that exit limitation is true
        here too; it's inherent to sub-dust on any Ark.
      </p>
      <p>
        Bark's real cost is fragmentation. Because VTXOs only ever split and never
        merge, they multiply — and the sharp part is that <em>when you receive money you
        don't control how many sub-dust pieces it arrives as</em>. You think you got
        30,000 sats; it could be a hundred 300-sat pieces, each with no unilateral-exit
        right — funds that depend entirely on the ASP. Arkade's design forbids spending
        sub-dust before a refresh, which is more restrictive, but it also means those
        fragmented, non-exitable crumbs can never land on you in the first place: an
        ordinary receive is always a single, fully-exitable chunk.
      </p>
      <p>
        So each design pays for its own strength. Bark buys relatively free sub-dust
        swaps at the risk that a receiver ends up holding fragmented, largely
        non-exitable money. Arkade keeps the upside — clean, single-chunk,
        fully-exitable receives — and its one real downside, no sub-dust swaps, is
        exactly the gap this wallet closes, <em>atomically</em>. So on this side you keep
        the Arkade design's strengths, with that weakness solved by this app.
      </p>

      <h2>I used the same key in another wallet — do the exit proofs stay correct?</h2>
      <p>
        First, what "another wallet" has to mean: the same key doesn't make two wallets
        compatible on its own — they also have to be on the <em>same Ark server</em>,
        because a VTXO only exists on the server that issued it. Which server this bridge
        talks to is the choice you made at fresh start: pick Official Arkade and you
        share a wallet with <code>arkade.money</code>; pick this bridge's operator (the
        default) and you share one with
        <code>https://wallet.hoppe-relay.it.com/</code>. With that settled — same key,
        same server — anything you receive in the other wallet, <em>including the change
        left over from its own sends</em>, shows up here and gets its exit proofs
        mirrored just the same.
      </p>
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
        address, the exit fuel) and the Nostr identity (NWC connections, the noffer).
        <code>bun run show-nsec</code> prints it. As long as the Ark server is
        cooperative you don't need to separately back up the exit proofs — the bridge
        re-mirrors them from the server on any fresh start, out of that one secret.
      </p>
      <p>
        <code>bun run show-btc-key</code> prints the <em>same</em> key as WIF +
        descriptor. It isn't a second thing to back up — it's the same secret in
        different clothing, there for one specific job: importing into any onchain
        descriptor wallet to directly reclaim the <strong>exit-fuel</strong> coins (the
        onchain sats that pay for CPFP/sweep during an exit) without this bridge. If you
        do that, note the imported wallet won't see those UTXOs until <em>you</em> run a
        rescan yourself.
      </p>

      <h2>What if the Ark server goes down — or disappears for good?</h2>
      <p>
        The bridge still boots (degraded mode) from its local vault and public
        esplora alone, and the <a href="/exit">Exit tab</a> works fully: unroll the
        pre-signed chains, wait out the timelock, sweep to an address you control.
        The clock that matters is each VTXO's expiry — exit before it. That is why
        <em>Exit readiness</em> lives on the dashboard rather than buried in a menu.
      </p>

      <h2>Do I need to keep the bridge running?</h2>
      <p>
        It comes down to how much you trust the server. Keep it running if you think the
        server might try to cheat you — a live bridge keeps proofs mirrored and runs
        refreshes automatically, so nothing quietly expires out from under you. Keep it
        running too if you use NWC, since those connections need it reachable.
      </p>
      <p>
        If you don't use NWC and don't think the server will cheat, it's fine to leave
        it off. Even past a VTXO's expiry a cooperative server will still refresh you
        into a clean VTXO — your money doesn't vanish the instant the clock ticks over.
        The catch is that this is a courtesy, not a cryptographic guarantee: once expiry
        passes, the trustless unilateral-exit proofs are dead paper and recovery is up
        to the server's goodwill. So the safe habit is to turn the bridge on once as
        each expiry window approaches — while it runs it refreshes you trustlessly,
        before the clock ever runs out. Expiry windows are measured in weeks (each
        VTXO's countdown is on the <a href="/send">Send tab</a>).
      </p>
    `,
  })
}
