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

  // ALL state is keyed by api base (host): a response captured on host A must
  // never be stored as host B's cache, decorate B's cards, or block B's
  // requests. The catalog carries a generation so a successful install/remove
  // can invalidate BOTH the cache and any pre-mutation request in flight.
  interface HostState {
    catalog: { items: CatalogItem[]; at: number } | null;
    gen: number; // bumped by a successful mutation: discards in-flight responses
    catalogReq: number | null; // generation the in-flight catalog fetch captured
    // Busy-state is PER PACKAGE, not panel-global: one slow npm install must
    // not dead-button every other card (the old global flag did exactly that,
    // silently). Errors persist across re-renders until the next attempt.
    busy: Map<string, { op: 'install' | 'remove'; started: number }>;
    lastErr: Map<string, string>;
  }
  const hosts = new Map<string, HostState>();
  function hostState(api: string): HostState {
    let h = hosts.get(api);
    if (!h) {
      h = { catalog: null, gen: 0, catalogReq: null, busy: new Map(), lastErr: new Map() };
      hosts.set(api, h);
    }
    return h;
  }
  const busyBtns = new Map<string, HTMLButtonElement>(); // rebuilt each render
  let busyApi = ''; // the api whose cards are on screen (the ticker's lookup)
  let ticker: ReturnType<typeof setInterval> | null = null;

  function busyLabel(h: HostState, key: string): string {
    const v = h.busy.get(key);
    if (!v) return '';
    const s = Math.round((Date.now() - v.started) / 1000);
    return `${v.op === 'install' ? 'Installing' : 'Removing'}… ${s}s`;
  }

  function ensureTicker() {
    ticker ??= setInterval(() => {
      const h = hosts.get(busyApi);
      if (h) {
        for (const key of h.busy.keys()) {
          const btn = busyBtns.get(key);
          if (btn) btn.textContent = busyLabel(h, key);
        }
      }
      if (![...hosts.values()].some((x) => x.busy.size) && ticker != null) {
        clearInterval(ticker);
        ticker = null;
      }
    }, 1000);
  }

  const CATALOG_TTL = 300_000;

  // Catalog is nearly static per daemon: cache per host and paint it
  // instantly; only a missing or stale (5 min) entry refetches, always in the
  // background of an already-painted list. Searches stay per-query (a query is
  // a fresh question, not a cacheable surface — fetch per open by design).
  async function load() {
    const my = ++seq;
    const api = opts.getApiBase(); // captured ONCE — never re-read after an await
    const h = hostState(api);
    if (!query) {
      const fresh = h.catalog != null && Date.now() - h.catalog.at <= CATALOG_TTL;
      if (h.catalog) {
        render(api, [
          ...h.catalog.items.map((c) => catalogCard(api, c)),
          note('the mymux catalog — curated, pinned upstream releases'),
        ]);
      } else {
        render(api, [note('loading…')]);
      }
      if (fresh) return;
      if (h.catalogReq === h.gen) return; // a current-generation request is in flight
      const gen = h.gen;
      h.catalogReq = gen;
      try {
        const r = await fetch(`${api}/pkgs/catalog`);
        const items = (await r.json()) as CatalogItem[];
        if (gen !== h.gen) return; // a mutation superseded this pre-mutation response
        h.catalog = { items, at: Date.now() };
        if (!open || my !== seq || api !== opts.getApiBase()) return;
        const rows = items.length ? items.map((c) => catalogCard(api, c)) : [note('no packages in the catalog')];
        rows.push(note('the mymux catalog — curated, pinned upstream releases'));
        render(api, rows);
      } catch {
        // Same-host, no-cache failure must surface the error (mirrors the
        // success guard at the top of the try: render only for the CURRENT
        // host). The inverted `!==` here left an unreachable daemon stuck on
        // "loading…" forever and could paint a switched-away host's error.
        if (!h.catalog && open && my === seq && api === opts.getApiBase()) {
          render(api, [note('could not reach the daemon')]);
        }
      } finally {
        if (h.catalogReq === gen) h.catalogReq = null;
      }
      return;
    }
    render(api, [note(`searching “${query}”…`)]);
    let rows: HTMLElement[];
    try {
      const r = await fetch(`${api}/pkgs/search?q=${encodeURIComponent(query)}`);
      const res = (await r.json()) as { hits: SearchHit[] };
      rows = res.hits.length
        ? res.hits.map((hit) => hitCard(api, hit))
        : [note(`nothing found for “${query}”`)];
    } catch {
      rows = [note('could not reach the daemon')];
    }
    if (!open || my !== seq || api !== opts.getApiBase()) return;
    rows.push(note('the mymux catalog — curated, pinned upstream releases'));
    render(api, rows);
  }

  function render(api: string, rows: HTMLElement[]) {
    busyApi = api;
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
  // or a dynamic spec (npm:…). Rendered FROM the host's busy map so a
  // mid-operation re-render (searching, refreshing) keeps the busy state.
  function actionBtn(api: string, installed: boolean, key: string): HTMLElement {
    const h = hostState(api);
    const btn = document.createElement('button');
    btn.className = 'pkgs-btn' + (installed ? '' : ' primary');
    busyBtns.set(key, btn);
    if (h.busy.has(key)) {
      btn.disabled = true;
      btn.textContent = busyLabel(h, key);
      return btn;
    }
    btn.textContent = installed ? 'Remove' : 'Install';
    btn.addEventListener('click', () => {
      if (h.busy.has(key)) return; // double-click; daemon also guards
      const op = installed ? 'remove' : 'install';
      h.busy.set(key, { op, started: Date.now() });
      h.lastErr.delete(key);
      btn.disabled = true;
      btn.textContent = busyLabel(h, key);
      ensureTicker();
      // Backstop only — the daemon enforces the real deadline (600s).
      const ctl = new AbortController();
      const kill = setTimeout(() => ctl.abort(), 630_000);
      let ok = false;
      void fetch(`${api}/pkgs/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: key }),
        signal: ctl.signal,
      })
        .then((r) => r.json())
        .then((res: { ok: boolean; err?: string }) => {
          ok = res.ok;
          if (!res.ok) h.lastErr.set(key, res.err ?? 'failed');
        })
        .catch(() => {
          h.lastErr.set(key, 'request failed (daemon unreachable or timed out)');
        })
        .finally(() => {
          clearTimeout(kill);
          h.busy.delete(key);
          if (ok) {
            // The catalog is wrong now — invalidate THIS host's cache (and any
            // pre-mutation request still in flight, via the generation bump) so
            // the re-render can't restore a stale Install/Remove button.
            h.gen++;
            h.catalog = null;
          }
          if (open) void load(); // re-render from fresh state either way
        });
    });
    return btn;
  }

  function errNote(api: string, key: string): HTMLElement[] {
    const e = hostState(api).lastErr.get(key);
    if (!e) return [];
    const n = note(`✗ ${e}`);
    n.classList.add('pkgs-err');
    return [n];
  }

  function catalogCard(api: string, it: CatalogItem): HTMLElement {
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
      ...errNote(api, it.name),
      actionBtn(api, it.installed, it.name),
    );
    return c;
  }

  function hitCard(api: string, h: SearchHit): HTMLElement {
    const c = document.createElement('div');
    c.className = 'pkgs-card';
    const desc = document.createElement('div');
    desc.className = 'pkgs-desc';
    desc.textContent = h.desc || h.spec;
    c.append(
      head(h.title || h.name, h.installed ? 'installed' : h.version, h.source, h.name),
      desc,
      ...errNote(api, h.spec),
      // Removal by spec works because the daemon maps a spec to its dir name.
      actionBtn(api, h.installed, h.spec),
    );
    return c;
  }

  return {
    isOpen: () => open,
    toggle() {
      open = !open;
      if (!open) {
        // Blur BEFORE hiding — a display:none subtree can keep focus on
        // WebKit (the search box would swallow post-close keystrokes).
        const ae = document.activeElement as HTMLElement | null;
        if (ae && panel.contains(ae)) ae.blur();
      }
      panel.classList.toggle('show', open);
      if (open) void load();
    },
  };
}
