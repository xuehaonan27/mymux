// The packages panel — mymux's own "marketplace", fed by the mymux-pkg
// recipe catalog through the daemon (`/pkgs/*`). Browse what's available,
// install/remove at YOUR initiative — mymux never nags about missing
// packages. Ecosystem boundary (docs/PKG-SPEC.md): upstream releases and
// Open VSX only; the VS Marketplace and MS proprietary extensions never.

interface CatalogItem {
  name: string;
  version: string;
  kind: string;
  langs: string[];
  desc: string;
  installed: boolean;
  installed_version?: string;
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

  async function load() {
    panel.replaceChildren(title(), note('loading…'));
    let items: CatalogItem[] = [];
    try {
      const r = await fetch(`${opts.getApiBase()}/pkgs/catalog`);
      items = (await r.json()) as CatalogItem[];
    } catch {
      panel.replaceChildren(title(), note('could not reach the daemon'));
      return;
    }
    if (!open) return;
    const root = [title()];
    if (!items.length) root.push(note('no packages in the catalog'));
    for (const it of items) root.push(card(it));
    root.push(
      note(
        'sources: pinned upstream releases & Open VSX · sha256-verified · never the VS Marketplace',
      ),
    );
    panel.replaceChildren(...root);
  }

  function title(): HTMLElement {
    const t = document.createElement('div');
    t.className = 'pkgs-title';
    t.textContent = 'Packages';
    return t;
  }

  function note(text: string): HTMLElement {
    const n = document.createElement('div');
    n.className = 'pkgs-note';
    n.textContent = text;
    return n;
  }

  function card(it: CatalogItem): HTMLElement {
    const c = document.createElement('div');
    c.className = 'pkgs-card';
    const head = document.createElement('div');
    head.className = 'pkgs-card-head';
    const name = document.createElement('span');
    name.className = 'pkgs-name';
    name.textContent = it.name;
    const ver = document.createElement('span');
    ver.className = 'pkgs-ver';
    ver.textContent = it.installed ? `${it.installed_version} installed` : it.version;
    head.append(name, ver);
    const desc = document.createElement('div');
    desc.className = 'pkgs-desc';
    desc.textContent = `${it.desc}  [${it.kind}${it.langs.length ? ': ' + it.langs.join(', ') : ''}]`;
    const btn = document.createElement('button');
    btn.className = 'pkgs-btn' + (it.installed ? '' : ' primary');
    btn.textContent = it.installed ? 'Remove' : 'Install';
    btn.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      btn.textContent = it.installed ? 'Removing…' : 'Installing… (may take a minute)';
      const ep = it.installed ? 'remove' : 'install';
      void fetch(`${opts.getApiBase()}/pkgs/${ep}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: it.name }),
      })
        .then((r) => r.json())
        .then((res: { ok: boolean; err?: string }) => {
          busy = false;
          if (!res.ok) {
            btn.disabled = false;
            btn.textContent = it.installed ? 'Remove' : 'Install';
            desc.textContent = `✗ ${res.err ?? 'failed'}`;
            return;
          }
          void load();
        })
        .catch(() => {
          busy = false;
          btn.disabled = false;
          desc.textContent = '✗ request failed';
        });
    });
    c.append(head, desc, btn);
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
