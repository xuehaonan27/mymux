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
}

const DEFAULTS: Prefs = {
  hostBarAlways: false,
  notify: false,
  codeRoot: 'pane',
  theme: 'mymux-night',
};

const KEY = 'mymux.prefs';

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return { ...DEFAULTS, ...raw };
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
  current = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(current));
  for (const fn of listeners) fn(current);
}

/** Subscribe to changes (also fires for other tabs' writes? no — same tab only). */
export function onPrefsChange(fn: (p: Prefs) => void): void {
  listeners.add(fn);
}
