// The client-side prefs store: one typed schema with defaults, localStorage
// persistence, and change notifications. Prefs are per-DEVICE on purpose (a
// Mac app seat and a browser seat legitimately differ); nothing here belongs
// on a host. The settings panel (settings.ts) is the surface over this.

export interface Prefs {
  /** Always show the host chip bar (even with a single host). */
  hostBarAlways: boolean;
  /** System alerts when an agent enters waiting/done while unfocused. */
  notify: boolean;
  /** The code panel's default root before any manual switch. */
  codeRoot: 'pane' | 'repo';
  /** Color theme preset id (ui/src/theme.ts PRESETS). */
  theme: string;
  /** Optional backdrop image behind the whole app (path or URL; '' = none). */
  bgImage: string;
  /** Dark overlay over the backdrop image, 0 (crisp) .. 1 (fully black). */
  bgDim: number;
  /** Terminal pane background opacity, 0 (see-through) .. 1 (solid). */
  paneOpacity: number;
  /** WHOLE-WINDOW opacity (desktop app only): < 1 lets the desktop show
   * through the window — iTerm-style transparency. 0 (see-through) .. 1. */
  windowOpacity: number;
  /** Terminal font size in px (⌘=/⌘-/⌘0 adjusts live). */
  fontSize: number;
}

const DEFAULTS: Prefs = {
  hostBarAlways: false,
  notify: false,
  codeRoot: 'pane',
  theme: 'mymux-night',
  bgImage: '',
  bgDim: 0.4,
  paneOpacity: 1,
  windowOpacity: 1,
  fontSize: 13,
};

export { DEFAULTS as PREFS_DEFAULTS };

const KEY = 'mymux.prefs';

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    const p = { ...DEFAULTS, ...raw };
    // Numbers come from sliders AND possibly a hand-edited localStorage —
    // clamp to 0..1 so a bad value can't blank the UI. NB: 0 is a VALID
    // setting (fully transparent), so no `|| default` shortcuts.
    const num = (v: unknown, dflt: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : dflt;
    p.bgDim = Math.min(1, Math.max(0, num(p.bgDim, DEFAULTS.bgDim)));
    p.paneOpacity = Math.min(1, Math.max(0, num(p.paneOpacity, DEFAULTS.paneOpacity)));
    p.windowOpacity = Math.min(1, Math.max(0, num(p.windowOpacity, DEFAULTS.windowOpacity)));
    p.fontSize = Math.min(28, Math.max(8, num(p.fontSize, DEFAULTS.fontSize)));
    if (typeof p.bgImage !== 'string') p.bgImage = '';
    return p;
  } catch {
    return { ...DEFAULTS };
  }
}

let current: Prefs = load();
const listeners = new Set<(p: Prefs) => void>();

export function getPrefs(): Prefs {
  return current;
}

export function setPrefs(patch: Partial<Prefs>) {
  const next = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // QuotaExceededError (a too-large bgImage data URL): commit nothing. If
    // `current` kept the giant value, EVERY later setPrefs would re-serialize
    // it, throw again, and never reach the listeners — prefs would silently
    // stop applying until reload.
    return;
  }
  current = next;
  for (const fn of listeners) fn(current);
}

/** Subscribe to changes (also fires for other tabs' writes? no — same tab only). */
export function onPrefsChange(fn: (p: Prefs) => void): void {
  listeners.add(fn);
}
