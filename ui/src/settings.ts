// The settings surface over the typed prefs store (prefs.ts). A small overlay
// in the pkgs/proc style; Esc closes (wired in main.ts). Controls write
// straight into the store — every consumer (bell, host bar, code panel)
// reacts via onPrefsChange.

import { getPrefs, setPrefs, type Prefs } from './prefs';
import { PRESETS } from './theme';

export interface SettingsPanel {
  toggle(): void;
  isOpen(): boolean;
}

export function initSettingsPanel(): SettingsPanel {
  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  document.body.appendChild(panel);
  let open = false;

  function checkboxRow(label: string, key: 'hostBarAlways' | 'notify', hint?: string): HTMLElement {
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = getPrefs()[key];
    c.addEventListener('change', () => setPrefs({ [key]: c.checked } as Partial<Prefs>));
    const l = document.createElement('label');
    l.append(c, document.createTextNode(' ' + label));
    const r = document.createElement('div');
    r.className = 'settings-row';
    r.append(l);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'settings-hint';
      h.textContent = hint;
      r.append(h);
    }
    return r;
  }

  function render() {
    const p = getPrefs();
    panel.replaceChildren();
    const title = document.createElement('div');
    title.className = 'pkgs-title';
    title.textContent = 'Settings';
    panel.append(title);

    // Theme preset: switch applies live (chrome / terminal / editor).
    const themeRow = document.createElement('div');
    themeRow.className = 'settings-row';
    const themeLab = document.createElement('span');
    themeLab.textContent = 'Theme: ';
    const sel = document.createElement('select');
    sel.className = 'settings-select';
    for (const preset of PRESETS) {
      const o = document.createElement('option');
      o.value = preset.id;
      o.textContent = preset.name;
      sel.appendChild(o);
    }
    sel.value = p.theme;
    sel.addEventListener('change', () => setPrefs({ theme: sel.value }));
    themeRow.append(themeLab, sel);
    panel.append(themeRow);

    panel.append(
      checkboxRow('Always show the host bar (even with one host)', 'hostBarAlways'),
      checkboxRow(
        'Notify when an agent needs me while unfocused',
        'notify',
        'The same switch as the bell in the bar — the OS may ask for permission first.',
      ),
    );

    const r = document.createElement('div');
    r.className = 'settings-row';
    const lab = document.createElement('span');
    lab.textContent = 'Default code root (⌘E):';
    r.append(lab);
    for (const [v, text] of [
      ['pane', 'pane cwd'],
      ['repo', 'repo root'],
    ] as const) {
      const rb = document.createElement('input');
      rb.type = 'radio';
      rb.name = 'codeRoot';
      rb.checked = p.codeRoot === v;
      rb.addEventListener('change', () => {
        if (rb.checked) setPrefs({ codeRoot: v });
      });
      const l = document.createElement('label');
      l.append(rb, document.createTextNode(' ' + text + ' '));
      r.append(l);
    }
    panel.append(r);
    const hint = document.createElement('div');
    hint.className = 'settings-hint';
    hint.textContent = 'You can still switch roots per pane with the root bar. Prefs live on this device (localStorage).';
    panel.append(hint);
  }

  return {
    isOpen: () => open,
    toggle() {
      open = !open;
      panel.classList.toggle('show', open);
      if (open) render();
    },
  };
}
