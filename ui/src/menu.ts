// Minimal body-appended popup menu for shell chrome (tab badges, host chips),
// styled by the shared .git-menu classes so it looks exactly like the git
// graph's context menu. One menu at a time; outside mousedown and Esc close
// it. The git graph keeps its own richer copy (prompt rows, two-click
// confirms); this is the plain-action variant.

export interface MenuItem {
  label: string;
  action: () => void;
}

let menuEl: HTMLElement | null = null;

export function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}

export function openMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'git-menu';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'git-menu-item';
    b.textContent = it.label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      it.action();
    });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
  menuEl = m;
}

document.addEventListener('mousedown', (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
});
// WINDOW capture, not document bubble: main.ts's modal-stack keydown is a
// document listener and would otherwise swallow the Esc (and close the whole
// panel) before we see it. Window capture runs first, so Esc closes just the
// menu. Same trick as gitgraph.ts.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && menuEl) {
      e.stopPropagation();
      closeMenu();
    }
  },
  true,
);
