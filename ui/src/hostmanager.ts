// Native host manager (Tauri only): pick/add SSH hosts, enter each key's
// passphrase in-app, and connect via the russh tunnels behind Tauri commands.
// Several hosts can be connected at once — `connect` returns that host's local
// forward port and `mymux:status` events are tagged with the host id. The panel
// force-shows at boot (nothing connected yet); afterwards it's an overlay for
// connecting more hosts / switching / disconnecting.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface Host {
  id: string;
  label: string;
  hostname: string;
  port: number;
  user: string;
  identity_path: string;
}
interface HostStore {
  hosts: Host[];
  default_id?: string | null;
}

// Mirrors the Rust `Status` (serde: unit variants → string; data variants → object).
type Status =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth_failed'
  | 'host_key_mismatch'
  | 'daemon_unreachable'
  | 'installing'
  | { host_key_unknown: { fingerprint: string } }
  | { error: string };

interface StatusEvent {
  host_id: string;
  status: Status;
}
interface ConnInfo {
  host_id: string;
  port: number;
  status?: Status | null;
}

export interface HostManagerHooks {
  /** A host's tunnel is up — give it a workspace (or switch to it). */
  onConnected(host: { id: string; label: string; port: number }): void;
  /** The user disconnected a host from the manager; its tunnel is already down. */
  onDisconnected(hostId: string): void;
  /** Client-side prefs surfaced in the manager (host bar visibility). */
  prefs: {
    hostBarAlways(): boolean;
    setHostBarAlways(v: boolean): void;
  };
}

export interface HostManager {
  open(): void;
}

export function initHostManager(hooks: HostManagerHooks): HostManager {
  const panel = document.createElement('div');
  panel.id = 'host';
  panel.className = 'host-panel show';
  document.body.appendChild(panel);

  // The connect attempt currently driven from this panel (for status routing
  // and the host-key trust retry). Events for other hosts are ignored here —
  // their workspaces live their own lives.
  let attempt: { host: Host; passphrase: string; port: number | null } | null = null;
  let statusEl: HTMLElement | null = null;
  let connectBtn: HTMLElement | null = null;
  // Hosts open at the end of the last session, not yet reconnected: at boot
  // we guide through them one passphrase at a time ("restore the session").
  // Backing store is maintained by the shell (mymux.openHosts).
  let restoreQueue: string[] = [];
  let booted = false;

  const openHostIds = (): string[] => {
    try {
      const v = JSON.parse(localStorage.getItem('mymux.openHosts') ?? 'null');
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    } catch {
      /* fall through */
    }
    const last = localStorage.getItem('mymux.lastHost'); // legacy, pre-multi
    return last ? [last] : [];
  };

  const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function setStatus(kind: 'info' | 'error' | 'warn', msg: string) {
    if (!statusEl) return;
    statusEl.className = `host-status ${kind}`;
    statusEl.textContent = msg;
  }

  async function loadHosts(): Promise<HostStore> {
    try {
      return await invoke<HostStore>('hosts_list');
    } catch {
      return { hosts: [] };
    }
  }

  async function loadConns(): Promise<Map<string, ConnInfo>> {
    try {
      const list = await invoke<ConnInfo[]>('conns_list');
      return new Map(list.map((c) => [c.host_id, c]));
    } catch {
      return new Map();
    }
  }

  // ---- views ----
  async function showList() {
    statusEl = null;
    attempt = null;
    const [store, conns] = await Promise.all([loadHosts(), loadConns()]);
    const root = el('div', 'host-inner');
    root.appendChild(el('div', 'host-title', 'Connect to a host'));
    if (!store.hosts.length) {
      root.appendChild(el('div', 'host-empty', 'No hosts yet — add one to get started.'));
    }
    const list = el('div', 'host-list');
    for (const h of store.hosts) list.appendChild(hostCard(h, conns.get(h.id)));
    root.appendChild(list);
    const add = el('button', 'host-btn', '+ Add host');
    add.onclick = () => showForm();
    root.appendChild(add);
    const pref = el('label', 'host-pref');
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = hooks.prefs.hostBarAlways();
    cb.onchange = () => hooks.prefs.setHostBarAlways(cb.checked);
    pref.append(cb, document.createTextNode(' Always show the host bar'));
    root.appendChild(pref);
    panel.replaceChildren(root);

    if (!booted) {
      booted = true;
      restoreQueue = openHostIds().filter(
        (id) => !conns.has(id) && store.hosts.some((x) => x.id === id),
      );
      const h = store.hosts.find((x) => x.id === restoreQueue[0]);
      if (h) showConnect(h);
    }
  }

  /// Hide the overlay AND release keyboard focus: a display:none'd input can
  /// keep focus in some webviews, and the workspace's focus logic deliberately
  /// never steals from an input — blur explicitly so the terminal can take it.
  function hidePanel() {
    panel.classList.remove('show');
    const ae = document.activeElement;
    if (ae instanceof HTMLElement) ae.blur();
  }

  /// Abort the connect attempt this panel is driving (kills the background
  /// tunnel task, which would otherwise keep retrying forever).
  async function cancelAttempt() {
    const a = attempt;
    attempt = null;
    if (a) await invoke('disconnect', { host_id: a.host.id }).catch(() => {});
  }

  function hostCard(h: Host, conn?: ConnInfo): HTMLElement {
    const live = conn?.status === 'connected';
    const card = el('div', 'host-card');
    const main = el('div', 'host-card-main');
    const labelRow = el('div', 'host-card-label');
    if (live) labelRow.appendChild(el('span', 'host-live', '●'));
    else if (conn) labelRow.appendChild(el('span', 'host-trying', '●'));
    labelRow.appendChild(document.createTextNode(h.label || h.hostname));
    if (!conn && restoreQueue.includes(h.id)) {
      const re = el('span', 'host-reopen', '↻');
      re.title = 'open last session — reconnect';
      labelRow.appendChild(re);
    }
    main.appendChild(labelRow);
    main.appendChild(
      el(
        'div',
        'host-card-sub',
        live || !conn
          ? `${h.user}@${h.hostname}:${h.port}`
          : `${h.user}@${h.hostname}:${h.port} — connecting…`,
      ),
    );
    card.appendChild(main);

    if (live && conn) {
      // Connected: open its workspace, or tear the tunnel down.
      main.onclick = () => {
        hidePanel();
        hooks.onConnected({ id: h.id, label: h.label || h.hostname, port: conn.port });
      };
      const open = el('button', 'host-btn small', 'Open');
      open.onclick = main.onclick as () => void;
      const dis = el('button', 'host-icon', '⏻');
      dis.title = 'Disconnect';
      dis.onclick = async (e) => {
        e.stopPropagation();
        await invoke('disconnect', { host_id: h.id }).catch(() => {});
        hooks.onDisconnected(h.id);
        void showList();
      };
      card.append(open, dis);
    } else if (conn) {
      // A background tunnel is still trying (connecting/reconnecting): the
      // only sensible action is to stop it.
      const stop = el('button', 'host-btn small', 'Cancel');
      stop.onclick = async (e) => {
        e.stopPropagation();
        await invoke('disconnect', { host_id: h.id }).catch(() => {});
        void showList();
      };
      card.append(stop);
    } else {
      main.onclick = () => showConnect(h);
      const edit = el('button', 'host-icon', '✎');
      edit.title = 'Edit';
      edit.onclick = (e) => {
        e.stopPropagation();
        showForm(h);
      };
      const del = el('button', 'host-icon', '✕');
      del.title = 'Delete';
      del.onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Delete host “${h.label || h.hostname}”?`)) {
          await invoke('host_delete', { id: h.id });
          void showList();
        }
      };
      card.append(edit, del);
    }
    return card;
  }

  function showConnect(h: Host) {
    const root = el('div', 'host-inner');
    const back = el('button', 'host-back', '← hosts');
    back.onclick = () => {
      restoreQueue = []; // user bailed out of the restore guide
      void cancelAttempt(); // …and of the in-flight attempt, if any
      showList();
    };
    root.append(
      back,
      el('div', 'host-title', h.label || h.hostname),
      el('div', 'host-card-sub', `${h.user}@${h.hostname}:${h.port}`),
    );
    const pass = el('input', 'host-input') as HTMLInputElement;
    pass.type = 'password';
    pass.placeholder = 'Key passphrase';
    const btn = el('button', 'host-btn primary', 'Connect');
    connectBtn = btn;
    const go = () => {
      if (attempt) {
        // Second click = cancel: kill the tunnel task (it would otherwise
        // retry forever against an unreachable host).
        void cancelAttempt().then(() => {
          btn.textContent = 'Connect';
          setStatus('info', 'Cancelled.');
        });
        return;
      }
      btn.textContent = 'Cancel';
      connect(h, pass.value, false);
    };
    pass.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    btn.onclick = go;
    statusEl = el('div', 'host-status');
    root.append(pass, btn, statusEl);
    panel.replaceChildren(root);
    pass.focus();
  }

  function showForm(h?: Host) {
    statusEl = null;
    const root = el('div', 'host-inner');
    const back = el('button', 'host-back', '← hosts');
    back.onclick = () => showList();
    root.append(back, el('div', 'host-title', h ? 'Edit host' : 'Add host'));
    const field = (labelText: string, val: string, type = 'text'): HTMLInputElement => {
      const wrap = el('label', 'host-field');
      wrap.appendChild(el('span', undefined, labelText));
      const inp = el('input', 'host-input') as HTMLInputElement;
      inp.type = type;
      inp.value = val;
      wrap.appendChild(inp);
      root.appendChild(wrap);
      return inp;
    };
    const label = field('Label', h?.label ?? '');
    const hostname = field('Hostname', h?.hostname ?? '');
    const port = field('Port', String(h?.port ?? 22));
    const user = field('User', h?.user ?? '');
    const ident = field('Identity file', h?.identity_path ?? '~/.ssh/id_ed25519');
    const save = el('button', 'host-btn primary', 'Save');
    save.onclick = async () => {
      const host: Host = {
        id: h?.id ?? `h${Date.now()}`,
        label: label.value.trim() || hostname.value.trim(),
        hostname: hostname.value.trim(),
        port: parseInt(port.value, 10) || 22,
        user: user.value.trim(),
        identity_path: ident.value.trim() || '~/.ssh/id_ed25519',
      };
      if (!host.hostname || !host.user) {
        alert('Hostname and user are required.');
        return;
      }
      await invoke('host_save', { host, make_default: false });
      void showList();
    };
    root.appendChild(save);
    panel.replaceChildren(root);
  }

  // ---- connect + live status ----
  async function connect(h: Host, passphrase: string, trust: boolean) {
    if (!statusEl) return;
    attempt = { host: h, passphrase, port: null };
    if (connectBtn) connectBtn.textContent = 'Cancel'; // every start path, incl. trust-retry
    setStatus('info', 'Connecting… (Cancel to stop)');
    try {
      attempt.port = await invoke<number>('connect', {
        host_id: h.id,
        passphrase,
        trust_host_key: trust,
      });
    } catch (e) {
      setStatus('error', String(e));
      attempt = null;
      if (connectBtn) connectBtn.textContent = 'Connect';
    }
  }

  function trustPrompt(fingerprint: string) {
    if (!statusEl || !attempt) return;
    const a = attempt;
    statusEl.className = 'host-status warn';
    statusEl.replaceChildren(el('div', undefined, `Unknown host key:\n${fingerprint}`));
    const trust = el('button', 'host-btn', 'Trust & connect');
    trust.onclick = () => connect(a.host, a.passphrase, true);
    statusEl.appendChild(trust);
  }

  function onStatus(ev: StatusEvent) {
    // Only the attempt driven from this panel is ours; connected hosts'
    // reconnect chatter is handled by their workspaces.
    if (!attempt || ev.host_id !== attempt.host.id) return;
    const s = ev.status;
    if (s === 'connected') {
      const a = attempt;
      attempt = null;
      hooks.onConnected({
        id: a.host.id,
        label: a.host.label || a.host.hostname,
        port: a.port ?? 8088,
      });
      restoreQueue = restoreQueue.filter((id) => id !== a.host.id);
      if (restoreQueue.length) {
        // Chain the restore: guide straight into the next host's passphrase.
        void (async () => {
          const [store, conns] = await Promise.all([loadHosts(), loadConns()]);
          restoreQueue = restoreQueue.filter(
            (id) => !conns.has(id) && store.hosts.some((x) => x.id === id),
          );
          const h = store.hosts.find((x) => x.id === restoreQueue[0]);
          if (h) {
            panel.classList.add('show');
            showConnect(h);
          } else {
            hidePanel();
          }
        })();
      } else {
        hidePanel();
      }
      return;
    }
    if (!statusEl) return;
    if (s === 'connecting') setStatus('info', 'Connecting…');
    else if (s === 'reconnecting') setStatus('info', 'Reconnecting…');
    else if (s === 'auth_failed') {
      setStatus('error', 'Authentication failed — wrong passphrase, or the key isn’t authorized.');
      settleAttempt();
    } else if (s === 'installing') {
      setStatus(
        'info',
        'mymuxd isn’t installed on that host — installing it now (a source build can take a few minutes)…',
      );
    } else if (s === 'daemon_unreachable') {
      setStatus(
        'error',
        'mymuxd is installed on that host but won’t start. Logs: journalctl --user -u mymuxd, or /tmp/mymuxd.log',
      );
      settleAttempt();
    } else if (s === 'host_key_mismatch') {
      setStatus(
        'error',
        '⚠ Host key CHANGED — refusing (possible attack). If expected, fix ~/.ssh/known_hosts.',
      );
      settleAttempt();
    } else if (typeof s === 'object' && 'host_key_unknown' in s) {
      trustPrompt(s.host_key_unknown.fingerprint);
      settleAttempt();
    } else if (typeof s === 'object' && 'error' in s) {
      setStatus('error', s.error);
      settleAttempt();
    }
  }

  /// A terminal (non-retrying) status arrived: this attempt is over — the
  /// Connect button becomes usable again for the next try.
  function settleAttempt() {
    attempt = null;
    if (connectBtn) connectBtn.textContent = 'Connect';
  }

  void listen<StatusEvent>('mymux:status', (ev) => onStatus(ev.payload));

  void showList();
  return {
    open: () => {
      panel.classList.add('show');
      void showList();
    },
  };
}
