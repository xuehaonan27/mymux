// Agent attention notifications — a system-level tap on the shoulder when an
// agent window enters waiting (needs your decision) or done (finished) while
// you are NOT looking at mymux. Desktop app: the Tauri notification plugin
// (Mac Notification Center); browser: the Notification API (which macOS
// browsers route through Notification Center too). Nothing needed from the
// daemon: agent states already ride every state broadcast (hooks for Claude /
// Kimi / opencode-plugin agents, output heuristics for the rest).
//
// Firing rules: notify only on a TRANSITION into waiting/done (a re-broadcast
// of the same state is not a new ask), and only while unfocused — when you're
// looking at mymux the tab badge + attention queue already say it.

import {
  isPermissionGranted as tauriIsGranted,
  onAction as tauriOnAction,
  requestPermission as tauriRequestPermission,
  sendNotification as tauriSend,
} from '@tauri-apps/plugin-notification';
import type { Workspace } from './workspace';

type AgentMark = 'running' | 'waiting' | 'done';

export interface JumpTarget {
  hostId: string;
  windowId: number;
  paneId?: number;
}

export interface NotifyDeps {
  isTauri: boolean;
  /** Focus the app and land on the notifying window (select + pane focus). */
  jumpTo(t: JumpTarget): void;
  /** Host display name for the notification body. */
  hostLabel(hostId: string): string;
  getEnabled(): boolean;
  setEnabled(v: boolean): void;
}

export interface Notifier {
  /** Diff one workspace's window agent states; fire on entering waiting/done. */
  watch(w: Workspace): void;
  /** The bell button: ensure permission, flip the pref, report the new state. */
  toggle(): Promise<'on' | 'off' | 'denied'>;
  /** Effective state for the button: off / on / denied (for styling + title). */
  state(): 'on' | 'off' | 'denied';
  /** A workspace ended: drop its tracked states and pending jump targets. */
  forget(hostId: string): void;
}

export function initNotify(deps: NotifyDeps): Notifier {
  const last = new Map<string, AgentMark>(); // host:win → last reported mark
  const primedHosts = new Set<string>(); // hosts whose first snapshot was adopted
  const targets = new Map<number, JumpTarget>(); // notification id → jump
  let nextId = 1;
  let lastFired: JumpTarget | null = null; // fallback when the id doesn't roundtrip
  let tauriUp = false;

  // Register the click handler once (app only; the browser channel wires
  // onclick per notification instead). The Tauri plugin API is import-safe in
  // a browser — commands are only INVOKED in the app.
  if (deps.isTauri) {
    tauriUp = true;
    void tauriOnAction((n) => {
      const t = (n.id != null ? targets.get(n.id) : undefined) ?? lastFired;
      if (t) deps.jumpTo(t);
    }).catch(() => {
      tauriUp = false; // plugin absent → browser-channel fallback
    });
  }

  function unfocused(): boolean {
    return document.visibilityState === 'hidden' || !document.hasFocus();
  }

  async function ensurePermission(): Promise<boolean> {
    if (deps.isTauri && tauriUp) {
      try {
        if (await tauriIsGranted()) return true;
        return (await tauriRequestPermission()) === 'granted';
      } catch {
        tauriUp = false; // fall through to the browser channel
      }
    }
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    return (await Notification.requestPermission()) === 'granted';
  }

  function fire(w: Workspace, winId: number, mark: AgentMark) {
    if (!unfocused()) return;
    const win = w.windowList.find((x) => x.id === winId);
    const title = mark === 'waiting' ? '⚠ agent needs a decision' : '✓ agent finished';
    const body = `${deps.hostLabel(w.id)} · ${win?.name || `window ${winId}`}`;
    const target: JumpTarget = { hostId: w.id, windowId: winId, paneId: win?.agent_pane };
    lastFired = target;
    if (deps.isTauri && tauriUp) {
      const id = nextId++;
      targets.set(id, target);
      try {
        tauriSend({ id, title, body });
      } catch {
        tauriUp = false;
      }
      return;
    }
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      deps.jumpTo(target);
      n.close();
    };
  }

  return {
    watch(w) {
      if (!deps.getEnabled()) return;
      // First snapshot after connecting: ADOPT the current states without
      // firing. Badges that predate this UI (agents that went waiting while
      // the app was closed) are summarized by the bar — they are not news,
      // and firing one notification per stale badge at every boot is spam.
      if (!primedHosts.has(w.id)) {
        primedHosts.add(w.id);
        for (const win of w.windowList) {
          const key = `${w.id}:${win.id}`;
          if (win.agent) last.set(key, win.agent as AgentMark);
          else last.delete(key);
        }
        return;
      }
      const seen = new Set<string>();
      for (const win of w.windowList) {
        const key = `${w.id}:${win.id}`;
        seen.add(key);
        const mark = win.agent as AgentMark | undefined;
        const prev = last.get(key);
        if (mark === prev) continue; // same state re-broadcast — not a new ask
        if (mark) last.set(key, mark);
        else last.delete(key);
        if (mark === 'waiting' || mark === 'done') fire(w, win.id, mark);
      }
      // Windows that vanished leave the map (their ids can be reused).
      for (const k of [...last.keys()]) {
        if (k.startsWith(`${w.id}:`) && !seen.has(k)) last.delete(k);
      }
    },

    async toggle() {
      if (deps.getEnabled()) {
        deps.setEnabled(false);
        return 'off';
      }
      if (!(await ensurePermission())) return 'denied';
      deps.setEnabled(true);
      return 'on';
    },

    state() {
      if (deps.getEnabled()) return 'on';
      if (!deps.isTauri && 'Notification' in window && Notification.permission === 'denied') {
        return 'denied';
      }
      return 'off';
    },

    forget(hostId) {
      primedHosts.delete(hostId);
      for (const k of [...last.keys()]) {
        if (k.startsWith(`${hostId}:`)) last.delete(k);
      }
      for (const [id, t] of [...targets]) {
        if (t.hostId === hostId) targets.delete(id);
      }
    },
  };
}
