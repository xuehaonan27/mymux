// The systematic key layer: ONE letter per action, everywhere. In the Tauri
// app the letter binds directly under ⌘ (⌘T, ⌘N, …); in a browser — which
// reserves most ⌘ combos — the SAME letter sits behind the ⌘K leader
// (⌘K t, ⌘K n, …). One table drives the dispatcher and the help overlay, so
// bindings can't drift and a future platform (Windows/Linux ctrl, mobile
// buttons) is just another projection of the same table.
//
// Principles (user, 2026-07-05): identical letters across platforms (arrows
// excepted), shift-free (sole exception: ⌘⇧1-9 hosts), one action = one key.

import type { Workspace } from './workspace';

export type ActionId =
  | 'new-psh'
  | 'new-sh'
  | 'new-tmux'
  | 'new-psh-dir'
  | 'close-pane'
  | 'split-right'
  | 'split-down'
  | 'zoom'
  | 'swap-prev'
  | 'swap-next'
  | 'break-pane'
  | 'keep-toggle'
  | 'win-prev'
  | 'win-next'
  | 'code'
  | 'proc'
  | 'attention'
  | 'plugins'
  | 'gitgraph'
  | 'settings'
  | 'help';

/** Everything actions need from the shell, injected once at startup. */
export interface KeyDeps {
  ws(): Workspace | null;
  openCwdPrompt(): void;
  toggleHelp(): void;
  toggleProc(): void;
  toggleCode(): void;
  jumpAttention(): void;
  /** ⌁↔∞ toggle on the active window (demote side confirms). */
  keepToggle(): void;
  togglePlugins(): void;
  toggleGitGraph(): void;
  toggleSettings(): void;
}

/// Where the letter binds directly under ⌘ (the leader always has it):
/// 'app' = Tauri only (browsers reserve it), 'all' = both, 'none' = leader-only
/// (low-frequency, or the letter clashes with the leader/pane keys).
type Direct = 'app' | 'all' | 'none';

interface ActionDef {
  key: string;
  direct: Direct;
  desc: string;
  run(d: KeyDeps): void;
}

export const ACTIONS: Record<ActionId, ActionDef> = {
  'new-psh': {
    key: 't',
    direct: 'app',
    desc: 'new window (∞ persistent — the default; the app opens with one)',
    run: (d) => d.ws()?.sendJson({ t: 'new_persistent' }),
  },
  'new-sh': {
    key: 'n',
    direct: 'app',
    desc: 'new throwaway shell (⌁ — dies with the daemon)',
    run: (d) => d.ws()?.sendJson({ t: 'new_ephemeral' }),
  },
  'new-tmux': {
    key: 'u',
    direct: 'app',
    desc: 'new tmux window (starts tmux on demand)',
    run: (d) => d.ws()?.sendJson({ t: 'new_window' }),
  },
  'new-psh-dir': {
    key: 'o',
    direct: 'app',
    desc: 'new ∞ window in a chosen directory',
    run: (d) => d.openCwdPrompt(),
  },
  'close-pane': {
    key: 'w',
    direct: 'app',
    desc: 'close pane (asks first when a job is running)',
    run: (d) => d.ws()?.closeActive(),
  },
  'split-right': { key: 'd', direct: 'all', desc: 'split right', run: (d) => d.ws()?.splitActive('h') },
  'split-down': { key: 'r', direct: 'app', desc: 'split down', run: (d) => d.ws()?.splitActive('v') },
  zoom: {
    key: 'm',
    direct: 'app',
    desc: 'zoom (maximize) the pane',
    run: (d) => {
      const w = d.ws();
      if (w?.activePane != null) w.sendJson({ t: 'zoom', pane: w.activePane });
    },
  },
  'swap-prev': {
    key: ',',
    direct: 'none',
    desc: 'swap pane with the previous one',
    run: (d) => d.ws()?.sendJson({ t: 'swap_pane', next: false }),
  },
  'swap-next': {
    key: '.',
    direct: 'none',
    desc: 'swap pane with the next one',
    run: (d) => d.ws()?.sendJson({ t: 'swap_pane', next: true }),
  },
  'break-pane': {
    key: 'b',
    direct: 'none',
    desc: 'break the pane out into its own window',
    run: (d) => {
      const w = d.ws();
      if (w?.activePane != null) w.sendJson({ t: 'break_pane', pane: w.activePane });
    },
  },
  'keep-toggle': {
    key: 'k',
    direct: 'none', // ⌘K IS the leader — this one lives only behind it
    desc: 'toggle keep: ⌁ → ∞, or ∞ → ⌁ (asks first)',
    run: (d) => d.keepToggle(),
  },
  'win-prev': { key: '[', direct: 'none', desc: 'previous window', run: (d) => d.ws()?.switchWindowRel(-1) },
  'win-next': { key: ']', direct: 'none', desc: 'next window', run: (d) => d.ws()?.switchWindowRel(1) },
  code: { key: 'e', direct: 'all', desc: 'code / diff panel', run: (d) => d.toggleCode() },
  proc: { key: 'i', direct: 'app', desc: 'process tree', run: (d) => d.toggleProc() },
  attention: {
    key: 'j',
    direct: 'all',
    desc: 'jump to the agent that needs you',
    run: (d) => d.jumpAttention(),
  },
  plugins: {
    key: 'g',
    direct: 'none', // ⌘G is find-next in many contexts; leader-only is fine
    desc: 'packages — browse & install language servers etc.',
    run: (d) => d.togglePlugins(),
  },
  gitgraph: {
    key: 'v',
    direct: 'none', // like the packages panel: leader-only
    desc: 'git graph — history, branches, diffs',
    run: (d) => d.toggleGitGraph(),
  },
  settings: {
    key: 's',
    direct: 'none',
    desc: 'settings',
    run: (d) => d.toggleSettings(),
  },
  help: { key: '/', direct: 'app', desc: 'key map (this help)', run: (d) => d.toggleHelp() },
};

const byKey = new Map<string, ActionId>(
  (Object.keys(ACTIONS) as ActionId[]).map((a) => [ACTIONS[a].key, a]),
);

/** ⌘+letter, honoring each action's direct level for the platform. */
export function directAction(key: string, isApp: boolean): ActionId | undefined {
  const a = byKey.get(key);
  if (!a) return undefined;
  const d = ACTIONS[a].direct;
  return d === 'all' || (d === 'app' && isApp) ? a : undefined;
}

/** ⌘K+letter — every action, both platforms, same letter. */
export function leaderAction(key: string): ActionId | undefined {
  return byKey.get(key);
}

/** Rows for the help overlay: [app combo, leader combo, description]. */
export function helpRows(): Array<[string, string, string]> {
  const order: ActionId[] = [
    'new-psh',
    'new-psh-dir',
    'new-sh',
    'new-tmux',
    'close-pane',
    'split-right',
    'split-down',
    'zoom',
    'swap-prev',
    'swap-next',
    'break-pane',
    'keep-toggle',
    'win-prev',
    'win-next',
    'code',
    'proc',
    'attention',
    'plugins',
    'gitgraph',
    'settings',
    'help',
  ];
  return order.map((a) => {
    const { key, direct, desc } = ACTIONS[a];
    const shown = key.length === 1 ? key.toUpperCase() : key;
    return [direct === 'none' ? '' : `⌘${shown}`, `⌘K ${key}`, desc];
  });
}
