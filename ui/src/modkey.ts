// Modifier-key state for ⌘/Ctrl-gated gestures (VS Code-style "hold the
// modifier to make paths clickable"). The terminal's link provider can't see
// modifier state when xterm asks it for links, so we track it globally.
// Capture listeners: panes swallow key events on their way out, capture
// doesn't care.

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The "command" modifier of the platform: meta on Apple, ctrl elsewhere. */
export function modOf(e: MouseEvent | KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

let held = false;
function sync(e: KeyboardEvent) {
  held = modOf(e);
}
window.addEventListener('keydown', sync, true);
window.addEventListener('keyup', sync, true);
window.addEventListener('blur', () => (held = false));

/** True while the platform command modifier is down. */
export function modHeld(): boolean {
  return held;
}
