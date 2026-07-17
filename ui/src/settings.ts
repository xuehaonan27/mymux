// The settings surface over the typed prefs store (prefs.ts). A small overlay
// in the pkgs/proc style; Esc closes (wired in main.ts). Controls write
// straight into the store — every consumer (bell, host bar, code panel)
// reacts via onPrefsChange.

import { getPrefs, setPrefs, type Prefs } from './prefs';
import { PRESETS } from './theme';

/** A chosen image file → downscaled JPEG data URL (max 2880px on the long
 * side), small enough for localStorage yet crisp on a retina screen. */
async function fileToDataUrl(file: File, maxDim = 2880): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('no canvas 2d');
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL('image/jpeg', 0.82);
}

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

    // Backdrop image + transparency: a local file (native picker — Finder in
    // the desktop app) downscaled to a data URL, or a typed URL; a dim
    // overlay for readability; how opaque panes / the whole window stay.
    const bgRow = document.createElement('div');
    bgRow.className = 'settings-row';
    const bgLab = document.createElement('span');
    bgLab.textContent = 'Background image: ';
    const choose = document.createElement('button');
    choose.className = 'pkgs-btn';
    choose.textContent = 'Choose image…';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    const urlInput = document.createElement('input');
    urlInput.className = 'settings-select settings-bginput';
    urlInput.placeholder = '…or paste an image URL and press Enter';
    urlInput.value = p.bgImage.startsWith('data:') ? '' : p.bgImage;
    const applyUrl = () => {
      setPrefs({ bgImage: urlInput.value.trim() });
      localName.textContent = '';
      clear.disabled = urlInput.value.trim().length === 0;
    };
    urlInput.addEventListener('change', applyUrl);
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyUrl();
      if (e.key !== 'Escape') e.stopPropagation(); // Esc must still close the panel
    });
    choose.addEventListener('click', () => fileInput.click());
    const clear = document.createElement('button');
    clear.className = 'pkgs-btn';
    clear.textContent = 'Remove';
    clear.title = 'Remove the background image (back to solid)';
    clear.disabled = p.bgImage.length === 0;
    clear.addEventListener('click', () => {
      setPrefs({ bgImage: '' });
      urlInput.value = '';
      localName.textContent = '';
      clear.disabled = true;
      fileInput.value = '';
    });
    const localName = document.createElement('span');
    localName.className = 'settings-hint';
    localName.textContent = p.bgImage.startsWith('data:') ? 'local image (stored on this device)' : '';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      void fileToDataUrl(f)
        .then((dataUrl) => {
          try {
            setPrefs({ bgImage: dataUrl });
            urlInput.value = '';
            localName.textContent = `local image: ${f.name} (stored on this device)`;
            clear.disabled = false;
          } catch {
            localName.textContent = 'image too large for local storage — try a smaller one';
          }
        })
        .catch(() => {
          localName.textContent = 'could not read that image file';
        });
    });
    bgRow.append(bgLab, choose, clear, fileInput, localName);
    panel.append(bgRow, urlInput);

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
      sliderRow('Pane opacity', p.paneOpacity, 0, 1, (v) => setPrefs({ paneOpacity: v })),
      sliderRow('Backdrop dim', p.bgDim, 0, 1, (v) => setPrefs({ bgDim: v })),
      sliderRow('Window opacity', p.windowOpacity, 0, 1, (v) => setPrefs({ windowOpacity: v })),
    );
    const bgHint = document.createElement('div');
    bgHint.className = 'settings-hint';
    bgHint.textContent =
      'Pane opacity and dim take effect once a backdrop image is set (inert otherwise). Window opacity (desktop app only) shows the desktop through the whole window and overrides the image.';
    panel.append(bgHint);

    // Terminal font size: −/+ stepper, same live-apply path as ⌘=/⌘-/⌘0.
    const fontRow = document.createElement('div');
    fontRow.className = 'settings-row settings-slider-row';
    const flab = document.createElement('span');
    flab.textContent = 'Terminal font size (⌘=/⌘-/⌘0)';
    const mkStep = (label: string, d: number) => {
      const b = document.createElement('button');
      b.className = 'pkgs-btn settings-fontstep';
      b.textContent = label;
      b.addEventListener('click', () => {
        const next = Math.min(28, Math.max(8, getPrefs().fontSize + d));
        setPrefs({ fontSize: next });
        fval.textContent = `${next}px`;
      });
      return b;
    };
    const fval = document.createElement('span');
    fval.className = 'settings-slider-val';
    fval.textContent = `${p.fontSize}px`;
    fontRow.append(flab, mkStep('−', -1), fval, mkStep('+', 1));
    panel.append(fontRow);

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
