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

    // Backdrop image + transparency: a path/URL behind the whole app, a dim
    // overlay for readability, and how opaque the terminal panes stay on top.
    const bgRow = document.createElement('div');
    bgRow.className = 'settings-row';
    const bgLab = document.createElement('span');
    bgLab.textContent = 'Background image (path or URL): ';
    const bgInput = document.createElement('input');
    bgInput.className = 'settings-select settings-bginput';
    bgInput.placeholder = '/Users/you/Pictures/wall.jpg or https://…';
    bgInput.value = p.bgImage;
    const applyBg = () => setPrefs({ bgImage: bgInput.value.trim() });
    bgInput.addEventListener('change', applyBg);
    bgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyBg();
      if (e.key !== 'Escape') e.stopPropagation(); // Esc must still close the panel
    });
    bgRow.append(bgLab, bgInput);
    panel.append(bgRow);

    const sliderRow = (
      label: string,
      value: number,
      min: number,
      max: number,
      apply: (v: number) => void,
    ): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'settings-row settings-slider-row';
      const lab = document.createElement('span');
      lab.textContent = label;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = '0.05';
      slider.value = String(value);
      const val = document.createElement('span');
      val.className = 'settings-slider-val';
      val.textContent = `${Math.round(value * 100)}%`;
      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        val.textContent = `${Math.round(v * 100)}%`;
        apply(v);
      });
      row.append(lab, slider, val);
      return row;
    };
    panel.append(
      sliderRow('Pane opacity', p.paneOpacity, 0.5, 1, (v) => setPrefs({ paneOpacity: v })),
      sliderRow('Backdrop dim', p.bgDim, 0, 0.8, (v) => setPrefs({ bgDim: v })),
    );
    const bgHint = document.createElement('div');
    bgHint.className = 'settings-hint';
    bgHint.textContent = 'Opacity and dim take effect once a backdrop image is set. Clear the field to go back to solid.';
    panel.append(bgHint);

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
