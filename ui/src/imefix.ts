// WKWebView IME rescue (the macOS app): Sogou & co. commit shifted symbols
// （, ？, …) — and some committed phrases — by firing a plain `insertText`
// input event with `composed: true` WITHOUT a compositionstart/end session,
// right after a keydown. xterm 6.0.0's input gate
// (CoreBrowserTerminal._inputEvent:
//   `(!ev.composed || !this._keyDownSeen)`)
// drops exactly that window — composed is true AND a keydown was seen — so the
// character vanishes. Chromium goes through the composition lane instead,
// which is why this only bites in the app. The reviewed upstream fix is
// xterm.js PR #5614 (unreleased), which accepts such events when no
// composition is in flight; this shim reproduces its effect from outside
// xterm, gated to the affected engine so Chromium behavior stays untouched.
//
// Mutual exclusion with xterm's own handler (which runs first — it registers
// at term.open, we register after, both capture on the same textarea):
//  - xterm ACCEPTS when `!composed || !keyDownSeen` → we require composed &&
//    our shadow keyDownSeen → its accept window can't overlap ours.
//  - xterm also refuses right after it SENT a key at keydown (_keyPressHandled)
//    → we skip when xterm emitted any data since that same keydown.
//  - During/just-after a real composition, xterm's CompositionHelper flushes
//    the committed text itself → we skip while composing (and one task past
//    compositionend, the flush window).
// Which leaves exactly the broken window for us: composed insertText, keydown
// seen, no composition, xterm silent. On every other path this shim is inert.

import type { Terminal } from '@xterm/xterm';
import { IS_MAC } from './modkey';

/** The app's webview is WKWebView (the only affected engine); `?imefix=1`
 * force-enables for the headless ux check on Chromium. */
export function imeFixEnabled(): boolean {
  if (new URLSearchParams(location.search).has('imefix')) return true;
  return IS_MAC && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

/** Install the rescue on one terminal; `send` must deliver bytes to the pty
 * exactly like xterm's own onData path. */
export function installImeFix(term: Terminal, send: (data: string) => void): void {
  const ta = term.textarea;
  if (!ta) return;

  let keyDownSeen = false;
  let composing = false;
  let ending = false;
  let xtermSends = 0;
  let sendsAtKeyDown = 0;

  term.onData(() => {
    xtermSends++;
  });
  ta.addEventListener('keydown', () => {
    keyDownSeen = true;
    sendsAtKeyDown = xtermSends; // sampled AFTER xterm's listener (reg. order)
  }, true);
  ta.addEventListener('keyup', () => {
    keyDownSeen = false;
  }, true);
  ta.addEventListener('compositionstart', () => {
    composing = true;
  }, true);
  ta.addEventListener('compositionend', () => {
    composing = false;
    ending = true;
    setTimeout(() => (ending = false), 0); // xterm flushes its diff on a 0ms timer
  }, true);
  ta.addEventListener(
    'input',
    (ev) => {
      if (!(ev instanceof InputEvent)) return;
      if (ev.inputType !== 'insertText' || !ev.data || !ev.composed) return;
      if (composing || ending || !keyDownSeen) return; // xterm's lanes
      if (xtermSends !== sendsAtKeyDown) return; // xterm already answered this key
      send(ev.data);
      ta.value = ''; // residue would be re-sent by xterm's next composition diff
    },
    true,
  );
}
