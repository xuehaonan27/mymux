// The packages panel — mymux's own "marketplace", fed through the daemon
// (`/pkgs/*`): the curated mymux-pkg catalog plus live search across Open VSX
// and npm (queried FROM the daemon host, which is the machine that can reach
// the registries). Browse and install at YOUR initiative — mymux never nags
// about missing packages. Ecosystem boundary (docs/PKG-SPEC.md): upstream
// releases, Open VSX and npm only; the VS Marketplace and MS proprietary
// extensions never.

interface CatalogItem {
  name: string;
  version: string;
  kind: string;
  langs: string[];
  desc: string;
  installed: boolean;
  installed_version?: string;
}

interface SearchHit {
  source: string; // curated | openvsx | npm
  spec: string; // what /pkgs/install accepts
  name: string;
  version: string;
  desc: string;
  installed: boolean;
}

export interface PkgsPanel {
  toggle(): void;
  isOpen(): boolean;
}

export function initPkgsPanel(opts: { getApiBase: () => string }): PkgsPanel {
  const panel = document.createElement('div');
  panel.className = 'pkgs-panel';
  document.body.appendChild(panel);
  let open = false;
  let busy = false;
  let query = ''; // sticky across re-renders (a search stays visible after install)
  let seq = 0; // stale-response guard: only the latest load may render

  async function load() {
    const my = ++seq;
    render([note(query ? `searching “${query}”…` : 'loading…')]);
    let rows: HTMLElement[];
    try {
      if (query) {
        const r = await fetch(
          `${opts.getApiBase()}/pkgs/search?q=${encodeURIComponent(query)}`,
        );
        const res = (await r.json()) as { hits: SearchHit[]; warnings?: string[] };
        rows = (res.warnings ?? []).map((w) => note(`⚠ ${w}`));
        rows.push(
          ...(res.hits.length
            ? res.hits.map((h) => hitCard(h))
            : [note(`nothing found for “${query}”`)]),
        );
      } else {
        const r = await fetch(`${opts.getApiBase()}/pkgs/catalog`);
        const items = (await r.json()) as CatalogItem[];
        rows = items.length
          ? items.map((it) => catalogCard(it))
          : [note('no packages in the catalog')];
      }
    } catch {
      rows = [note('could not reach the daemon')];
    }
    if (!open || my !== seq) return;
    rows.push(
      note(
        'sources: pinned upstream releases · Open VSX · npm — never the VS Marketplace',
      ),
    );
    render(rows);
  }

  function render(rows: HTMLElement[]) {
    panel.replaceChildren(title(), searchRow(), ...rows);
  }

  function title(): HTMLElement {
    const t = document.createElement('div');
    t.className = 'pkgs-title';
    t.textContent = 'Packages';
    return t;
  }

  function searchRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pkgs-search';
    const input = document.createElement('input');
    input.className = 'pkgs-search-input';
    input.placeholder = 'search Open VSX + npm + curated… (Enter)';
    input.value = query;
    // Enter-to-submit is fine here: the input lives in a panel, not over a
    // terminal, and search is idempotent. Esc stays unbound (agent discipline).
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        query = input.value.trim();
        void load();
      }
      e.stopPropagation(); // typing must not trigger app keymap letters
    });
    const clear = document.createElement('button');
    clear.className = 'pkgs-btn';
    clear.textContent = 'Catalog';
    clear.title = 'back to the curated catalog';
    clear.addEventListener('click', () => {
      query = '';
      void load();
    });
    row.append(input, clear);
    return row;
  }

  function note(text: string): HTMLElement {
    const n = document.createElement('div');
    n.className = 'pkgs-note';
    n.textContent = text;
    return n;
  }

  function head(name: string, right: string, badge?: string): HTMLElement {
    const h = document.createElement('div');
    h.className = 'pkgs-card-head';
    const n = document.createElement('span');
    n.className = 'pkgs-name';
    n.textContent = name;
    h.append(n);
    if (badge) {
      const b = document.createElement('span');
      b.className = `pkgs-badge pkgs-badge-${badge}`;
      b.textContent = badge;
      h.append(b);
    }
    const v = document.createElement('span');
    v.className = 'pkgs-ver';
    v.textContent = right;
    h.append(v);
    return h;
  }

  // One Install/Remove button with busy handling; `name` is what the daemon
  // gets — a curated name or a dynamic spec (openvsx:… / npm:…).
  function actionBtn(installed: boolean, name: string, onErr: (m: string) => void): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'pkgs-btn' + (installed ? '' : ' primary');
    btn.textContent = installed ? 'Remove' : 'Install';
    btn.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      btn.textContent = installed ? 'Removing…' : 'Installing… (may take a minute)';
      const ep = installed ? 'remove' : 'install';
      void fetch(`${opts.getApiBase()}/pkgs/${ep}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
        .then((r) => r.json())
        .then((res: { ok: boolean; err?: string }) => {
          busy = false;
          if (!res.ok) {
            btn.disabled = false;
            btn.textContent = installed ? 'Remove' : 'Install';
            onErr(`✗ ${res.err ?? 'failed'}`);
            return;
          }
          void load();
        })
        .catch(() => {
          busy = false;
          btn.disabled = false;
          onErr('✗ request failed');
        });
    });
    return btn;
  }

  function catalogCard(it: CatalogItem): HTMLElement {
    const c = document.createElement('div');
    c.className = 'pkgs-card';
    const desc = document.createElement('div');
    desc.className = 'pkgs-desc';
    desc.textContent = `${it.desc}  [${it.kind}${it.langs.length ? ': ' + it.langs.join(', ') : ''}]`;
    c.append(
      head(it.name, it.installed ? `${it.installed_version} installed` : it.version),
      desc,
      actionBtn(it.installed, it.name, (m) => (desc.textContent = m)),
    );
    return c;
  }

  function hitCard(h: SearchHit): HTMLElement {
    const c = document.createElement('div');
    c.className = 'pkgs-card';
    const desc = document.createElement('div');
    desc.className = 'pkgs-desc';
    desc.textContent = h.desc || h.spec;
    c.append(
      head(h.name, h.installed ? 'installed' : h.version, h.source),
      desc,
      // Removal by spec works because the daemon maps a spec to its dir name.
      actionBtn(h.installed, h.spec, (m) => (desc.textContent = m)),
    );
    if (h.source === 'npm' && !h.installed) {
      c.append(
        note('after install, bind a server to file types: mymux-pkg lang <pkg> <lang…> -- <args>'),
      );
    }
    return c;
  }

  return {
    isOpen: () => open,
    toggle() {
      open = !open;
      panel.classList.toggle('show', open);
      if (open) void load();
    },
  };
}
