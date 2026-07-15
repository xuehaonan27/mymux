// The packages panel — mymux's own curated catalog, fed through the daemon
// (`/pkgs/*`) from the mymux-pkg index. Browse and install at YOUR initiative
// — mymux never nags about missing packages. Ecosystem boundary
// (docs/PKG-SPEC.md): the catalog is the whole store; npm/github/go are
// install *channels* for pinned entries, never browse sources.

interface CatalogItem {
  name: string;
  title?: string; // friendly display name (index entries)
  version: string;
  kind: string;
  langs: string[];
  desc: string;
  installed: boolean;
  installed_version?: string;
  spec?: string;
}

interface SearchHit {
  source: string; // always "curated" — the catalog is the only browse source
  spec: string; // what /pkgs/install accepts
  name: string;
  title?: string; // index title
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
  let query = ''; // sticky across re-renders (a search stays visible after install)
  let seq = 0; // stale-response guard: only the latest load may render

  // Busy-state is PER PACKAGE, not panel-global: one slow npm install must
  // not dead-button every other card (the old global flag did exactly that,
  // silently). Errors persist across re-renders until the next attempt.
  const inflight = new Map<string, { op: 'install' | 'remove'; started: number }>();
  const lastErr = new Map<string, string>();
  const busyBtns = new Map<string, HTMLButtonElement>(); // rebuilt each render
  let ticker: ReturnType<typeof setInterval> | null = null;

  function busyLabel(key: string): string {
    const v = inflight.get(key);
    if (!v) return '';
    const s = Math.round((Date.now() - v.started) / 1000);
    return `${v.op === 'install' ? 'Installing' : 'Removing'}… ${s}s`;
  }

  function ensureTicker() {
    ticker ??= setInterval(() => {
      for (const key of inflight.keys()) {
        const btn = busyBtns.get(key);
        if (btn) btn.textContent = busyLabel(key);
      }
      if (!inflight.size && ticker != null) {
        clearInterval(ticker);
        ticker = null;
      }
    }, 1000);
  }

  async function load() {
    const my = ++seq;
    render([note(query ? `searching “${query}”…` : 'loading…')]);
    let rows: HTMLElement[];
    try {
      if (query) {
        const r = await fetch(
          `${opts.getApiBase()}/pkgs/search?q=${encodeURIComponent(query)}`,
        );
        const res = (await r.json()) as { hits: SearchHit[] };
        rows = res.hits.length
          ? res.hits.map((h) => hitCard(h))
          : [note(`nothing found for “${query}”`)];
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
    rows.push(note('the mymux catalog — curated, pinned upstream releases'));
    render(rows);
  }

  function render(rows: HTMLElement[]) {
    busyBtns.clear();
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
    input.placeholder = 'search the catalog… (Enter)';
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

  function head(name: string, right: string, badge?: string, sub?: string): HTMLElement {
    const h = document.createElement('div');
    h.className = 'pkgs-card-head';
    const n = document.createElement('span');
    n.className = 'pkgs-name';
    n.textContent = name;
    h.append(n);
    if (sub && sub !== name) {
      const s = document.createElement('span');
      s.className = 'pkgs-sub';
      s.textContent = sub;
      h.append(s);
    }
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

  // One Install/Remove button; `key` is what the daemon gets — a curated name
  // or a dynamic spec (npm:…). Rendered FROM the inflight map so a
  // mid-operation re-render (searching, refreshing) keeps the busy state.
  function actionBtn(installed: boolean, key: string): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'pkgs-btn' + (installed ? '' : ' primary');
    busyBtns.set(key, btn);
    if (inflight.has(key)) {
      btn.disabled = true;
      btn.textContent = busyLabel(key);
      return btn;
    }
    btn.textContent = installed ? 'Remove' : 'Install';
    btn.addEventListener('click', () => {
      if (inflight.has(key)) return; // double-click; daemon also guards
      const op = installed ? 'remove' : 'install';
      inflight.set(key, { op, started: Date.now() });
      lastErr.delete(key);
      btn.disabled = true;
      btn.textContent = busyLabel(key);
      ensureTicker();
      // Backstop only — the daemon enforces the real deadline (600s).
      const ctl = new AbortController();
      const kill = setTimeout(() => ctl.abort(), 630_000);
      void fetch(`${opts.getApiBase()}/pkgs/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: key }),
        signal: ctl.signal,
      })
        .then((r) => r.json())
        .then((res: { ok: boolean; err?: string }) => {
          if (!res.ok) lastErr.set(key, res.err ?? 'failed');
        })
        .catch(() => {
          lastErr.set(key, 'request failed (daemon unreachable or timed out)');
        })
        .finally(() => {
          clearTimeout(kill);
          inflight.delete(key);
          if (open) void load(); // re-render from fresh state either way
        });
    });
    return btn;
  }

  function errNote(key: string): HTMLElement[] {
    const e = lastErr.get(key);
    if (!e) return [];
    const n = note(`✗ ${e}`);
    n.classList.add('pkgs-err');
    return [n];
  }

  function catalogCard(it: CatalogItem): HTMLElement {
    const c = document.createElement('div');
    c.className = 'pkgs-card';
    const desc = document.createElement('div');
    desc.className = 'pkgs-desc';
    desc.textContent = `${it.desc}  [${it.kind}${it.langs.length ? ': ' + it.langs.join(', ') : ''}]`;
    c.append(
      head(
        it.title || it.name,
        it.installed ? `${it.installed_version} installed` : it.version,
        undefined,
        it.name,
      ),
      desc,
      ...errNote(it.name),
      actionBtn(it.installed, it.name),
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
      head(h.title || h.name, h.installed ? 'installed' : h.version, h.source, h.name),
      desc,
      ...errNote(h.spec),
      // Removal by spec works because the daemon maps a spec to its dir name.
      actionBtn(h.installed, h.spec),
    );
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
