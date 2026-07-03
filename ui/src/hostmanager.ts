// Native host manager (Tauri only): pick/add an SSH host, enter its key
// passphrase in-app, and connect via the russh tunnel behind Tauri commands.
// Shown until the tunnel reports `connected`; drives connect/disconnect and
// surfaces auth / host-key problems.

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
  | { host_key_unknown: { fingerprint: string } }
  | { error: string };

export interface HostManager {
  open(): void;
  isConnected(): boolean;
}

export function initHostManager(onConnected: () => void): HostManager {
  const panel = document.createElement('div');
  panel.id = 'host';
  panel.className = 'host-panel show';
  document.body.appendChild(panel);

  let connected = false;
  // Host + passphrase of the in-flight attempt, so a host-key-trust retry can resend.
  let attempt: { host: Host; passphrase: string } | null = null;
  let statusEl: HTMLElement | null = null;

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

  async function load(): Promise<HostStore> {
    try {
      return await invoke<HostStore>('hosts_list');
    } catch {
      return { hosts: [] };
    }
  }

  // ---- views ----
  async function showList() {
    statusEl = null;
    attempt = null;
    const store = await load();
    const root = el('div', 'host-inner');
    root.appendChild(el('div', 'host-title', 'Connect to a host'));
    if (!store.hosts.length) {
      root.appendChild(el('div', 'host-empty', 'No hosts yet — add one to get started.'));
    }
    const list = el('div', 'host-list');
    for (const h of store.hosts) list.appendChild(hostCard(h));
    root.appendChild(list);
    const add = el('button', 'host-btn', '+ Add host');
    add.onclick = () => showForm();
    root.appendChild(add);
    panel.replaceChildren(root);
  }

  function hostCard(h: Host): HTMLElement {
    const card = el('div', 'host-card');
    const main = el('div', 'host-card-main');
    main.appendChild(el('div', 'host-card-label', h.label || h.hostname));
    main.appendChild(el('div', 'host-card-sub', `${h.user}@${h.hostname}:${h.port}`));
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
    card.append(main, edit, del);
    return card;
  }

  function showConnect(h: Host) {
    const root = el('div', 'host-inner');
    const back = el('button', 'host-back', '← hosts');
    back.onclick = () => showList();
    root.append(
      back,
      el('div', 'host-title', h.label || h.hostname),
      el('div', 'host-card-sub', `${h.user}@${h.hostname}:${h.port}`),
    );
    const pass = el('input', 'host-input') as HTMLInputElement;
    pass.type = 'password';
    pass.placeholder = 'Key passphrase';
    const go = () => connect(h, pass.value, false);
    pass.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    const btn = el('button', 'host-btn primary', 'Connect');
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
    attempt = { host: h, passphrase };
    setStatus('info', 'Connecting…');
    try {
      await invoke('connect', { host_id: h.id, passphrase, trust_host_key: trust });
    } catch (e) {
      setStatus('error', String(e));
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

  function onStatus(s: Status) {
    if (s === 'connected') {
      connected = true;
      panel.classList.remove('show');
      onConnected();
      return;
    }
    if (connected || !statusEl) return; // ignore transient events once we're in
    if (s === 'connecting') setStatus('info', 'Connecting…');
    else if (s === 'reconnecting') setStatus('info', 'Reconnecting…');
    else if (s === 'auth_failed')
      setStatus('error', 'Authentication failed — wrong passphrase, or the key isn’t authorized.');
    else if (s === 'host_key_mismatch')
      setStatus(
        'error',
        '⚠ Host key CHANGED — refusing (possible attack). If expected, fix ~/.ssh/known_hosts.',
      );
    else if (typeof s === 'object' && 'host_key_unknown' in s)
      trustPrompt(s.host_key_unknown.fingerprint);
    else if (typeof s === 'object' && 'error' in s) setStatus('error', s.error);
  }

  void listen<Status>('mymux:status', (ev) => onStatus(ev.payload));

  void showList();
  return {
    open: () => {
      connected = false;
      panel.classList.add('show');
      void showList();
    },
    isConnected: () => connected,
  };
}
