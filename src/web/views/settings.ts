import { html, raw, type RawHtml } from '../../lib/html'
import { layout } from './layout'

/**
 * Account / backup page. The setup flow promises the nsec stays
 * viewable "at any time" — this is where that promise is kept. The
 * npub is public (it's already inside every Ark address and noffer);
 * the nsec controls all funds, so it's gated behind a reveal click to
 * avoid shoulder-surfing, with a loud lose-it-lose-everything warning.
 *
 * The reveal is cosmetic only — the nsec is in the page HTML regardless,
 * which is fine: this route is loopback-only and the value is the same
 * one shown on the setup screen. Clipboard works because 127.0.0.1 is a
 * secure context for the Clipboard API.
 */
export function settingsView(args: { nsec: string; npub: string }): RawHtml {
  return layout({
    title: 'Settings',
    current: 'settings',
    body: html`
      <h2>Nostr identity</h2>
      <p class="muted">
        This bridge's account key is also its Nostr identity. The npub
        below is what receives over NWC and CLINK — it's public, share it
        freely.
      </p>
      <pre data-npub-box>${args.npub}</pre>
      <button type="button" data-copy-npub>Copy npub</button>

      <h2>Backup</h2>
      <p class="bad">
        <strong
          >Anyone with this nsec controls every sat in this wallet.
          Losing it without a copy means the funds are gone for good.</strong
        >
        Write it down offline. Never paste it into a website or chat.
      </p>
      <button type="button" data-reveal>Reveal nsec</button>
      <pre data-nsec-box hidden>${args.nsec}</pre>
      <button type="button" data-copy-nsec hidden>Copy nsec</button>

      ${raw(SETTINGS_SCRIPT)}
    `,
  })
}

// Reveal-on-click for the nsec + clipboard copy for both keys. No
// framework: query the rendered <pre> by data-attr, copy its
// textContent (the un-escaped value), flash "Copied". navigator.clipboard
// is available because the bridge is served from 127.0.0.1 (secure
// context). Kept page-local rather than in layout's LIVE_SCRIPT since
// nothing else needs it.
const SETTINGS_SCRIPT = `<script>
(function () {
  function flash(btn) {
    var prev = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(function () { btn.textContent = prev; }, 1200);
  }
  function copyFrom(selector, btn) {
    var el = document.querySelector(selector);
    if (!el || !navigator.clipboard) return;
    navigator.clipboard.writeText(el.textContent).then(function () { flash(btn); });
  }
  var npubBtn = document.querySelector('[data-copy-npub]');
  if (npubBtn) npubBtn.addEventListener('click', function () { copyFrom('[data-npub-box]', npubBtn); });

  var reveal = document.querySelector('[data-reveal]');
  if (reveal) reveal.addEventListener('click', function () {
    var box = document.querySelector('[data-nsec-box]');
    var copyBtn = document.querySelector('[data-copy-nsec]');
    if (box) box.hidden = false;
    if (copyBtn) copyBtn.hidden = false;
    reveal.hidden = true;
  });
  var nsecBtn = document.querySelector('[data-copy-nsec]');
  if (nsecBtn) nsecBtn.addEventListener('click', function () { copyFrom('[data-nsec-box]', nsecBtn); });
})();
</script>`
