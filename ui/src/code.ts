import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { rust } from '@codemirror/lang-rust';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';

const API = 'http://127.0.0.1:8088';

interface FsEntry {
  name: string;
  dir: boolean;
  size: number;
}
interface GitFile {
  status: string;
  path: string;
}

// The panel is rooted at the focused pane's cwd, so every fetch carries its id.
const paneQ = (pane: number | null) => (pane != null ? `pane=${pane}&` : '');

async function fsList(pane: number | null, path: string): Promise<FsEntry[]> {
  const r = await fetch(`${API}/fs/list?${paneQ(pane)}path=${encodeURIComponent(path)}`);
  return r.ok ? r.json() : [];
}
async function fsRead(pane: number | null, path: string): Promise<string> {
  const r = await fetch(`${API}/fs/read?${paneQ(pane)}path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`read ${path}: ${r.status}`);
  return r.text();
}
async function fsWrite(pane: number | null, path: string, content: string): Promise<boolean> {
  const r = await fetch(`${API}/fs/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content, pane: pane ?? undefined }),
  });
  return r.ok;
}
async function gitStatus(pane: number | null): Promise<GitFile[]> {
  const r = await fetch(`${API}/git/status?${paneQ(pane)}`);
  return r.ok ? r.json() : [];
}
async function gitDiff(pane: number | null, path: string): Promise<string> {
  const r = await fetch(`${API}/git/diff?${paneQ(pane)}path=${encodeURIComponent(path)}`);
  return r.ok ? r.text() : '';
}

function langFor(path: string): Extension {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'rs':
      return rust();
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: ext === 'jsx' });
    case 'py':
      return python();
    case 'json':
      return json();
    case 'md':
    case 'markdown':
      return markdown();
    default:
      return [];
  }
}

export interface CodePanel {
  toggle(): void;
  isOpen(): boolean;
}

/** The ⌘E code overlay, rooted at the focused pane's cwd. */
export function initCodePanel(getActivePane: () => number | null): CodePanel {
  const panel = document.createElement('div');
  panel.id = 'code';
  panel.className = 'code-panel';
  panel.innerHTML = `
    <div class="code-side">
      <div class="code-side-hd">changes</div>
      <div class="code-changes" id="code-changes"></div>
      <div class="code-side-hd" id="code-root">files</div>
      <div class="code-tree" id="code-tree"></div>
    </div>
    <div class="code-main">
      <div class="code-hd"><span id="code-path">no file open</span><span id="code-hint">⌘S save · esc / ⌘E close</span></div>
      <div class="code-editor" id="code-editor"></div>
      <div class="code-diff" id="code-diff"></div>
    </div>`;
  document.body.appendChild(panel);

  const treeEl = panel.querySelector('#code-tree') as HTMLElement;
  const changesEl = panel.querySelector('#code-changes') as HTMLElement;
  const pathEl = panel.querySelector('#code-path') as HTMLElement;
  const editorParent = panel.querySelector('#code-editor') as HTMLElement;
  const diffEl = panel.querySelector('#code-diff') as HTMLElement;
  diffEl.style.display = 'none';

  let editor: EditorView | null = null;
  let currentPath: string | null = null;
  let savedDoc = '';
  let dirty = false;
  let rootPane: number | null = null;
  const langComp = new Compartment();

  function renderHeader() {
    if (!currentPath) {
      pathEl.textContent = 'no file open';
      pathEl.style.color = '';
      return;
    }
    pathEl.textContent = (dirty ? '● ' : '') + currentPath;
    pathEl.style.color = dirty ? '#d6a04c' : '';
  }

  // Returns false if the user cancels leaving an unsaved file.
  function confirmDiscard(): boolean {
    return !dirty || window.confirm(`Discard unsaved changes to ${currentPath}?`);
  }

  async function save() {
    if (!editor || !currentPath) return;
    const doc = editor.state.doc.toString();
    const ok = await fsWrite(rootPane, currentPath, doc);
    if (ok) {
      savedDoc = doc;
      dirty = false;
      const p = currentPath;
      pathEl.textContent = `${p}   ✓ saved`;
      setTimeout(() => {
        if (currentPath === p) renderHeader();
      }, 1200);
    } else {
      pathEl.textContent = `${currentPath}   ✗ save failed`;
    }
  }

  async function openFile(path: string) {
    if (!confirmDiscard()) return;
    let content: string;
    try {
      content = await fsRead(rootPane, path);
    } catch {
      pathEl.textContent = `cannot open ${path} (binary or too large?)`;
      return;
    }
    currentPath = path;
    savedDoc = content;
    dirty = false;
    renderHeader();
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        oneDark,
        langComp.of(langFor(path)),
        keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (void save(), true) }]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            dirty = u.state.doc.toString() !== savedDoc;
            renderHeader();
          }
        }),
      ],
    });
    if (editor) editor.setState(state);
    else editor = new EditorView({ state, parent: editorParent });
    editorParent.style.display = '';
    diffEl.style.display = 'none';
    editor.focus();
  }

  async function showDiff(path: string) {
    if (!confirmDiscard()) return;
    currentPath = null;
    dirty = false;
    pathEl.textContent = `diff · ${path}`;
    pathEl.style.color = '';
    const text = (await gitDiff(rootPane, path)) || '(no textual diff)';
    diffEl.replaceChildren();
    for (const line of text.split('\n')) {
      const el = document.createElement('div');
      const c = line[0];
      el.className =
        'dl ' +
        (line.startsWith('@@')
          ? 'dhunk'
          : /^(diff |index |--- |\+\+\+ |new file|deleted )/.test(line)
            ? 'dmeta'
            : c === '+'
              ? 'dadd'
              : c === '-'
                ? 'ddel'
                : '');
      el.textContent = line || ' ';
      diffEl.appendChild(el);
    }
    editorParent.style.display = 'none';
    diffEl.style.display = '';
  }

  function treeItem(path: string, name: string, dir: boolean, depth: number): HTMLElement {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'trow' + (dir ? ' tdir' : ' tfile');
    row.style.paddingLeft = `${depth * 12 + 8}px`;
    row.textContent = (dir ? '▸ ' : '') + name;
    wrap.appendChild(row);

    if (dir) {
      const kids = document.createElement('div');
      kids.style.display = 'none';
      wrap.appendChild(kids);
      let loaded = false;
      let open = false;
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        open = !open;
        row.textContent = (open ? '▾ ' : '▸ ') + name;
        kids.style.display = open ? '' : 'none';
        if (open && !loaded) {
          loaded = true;
          for (const c of await fsList(rootPane, path)) {
            kids.appendChild(treeItem(path ? `${path}/${c.name}` : c.name, c.name, c.dir, depth + 1));
          }
        }
      });
    } else {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        void openFile(path);
      });
    }
    return wrap;
  }

  async function loadTree() {
    treeEl.replaceChildren();
    for (const c of await fsList(rootPane, '')) {
      treeEl.appendChild(treeItem(c.name, c.name, c.dir, 0));
    }
  }

  async function loadChanges() {
    const files = await gitStatus(rootPane);
    changesEl.replaceChildren();
    if (!files.length) {
      changesEl.textContent = 'clean';
      return;
    }
    for (const f of files) {
      const s = f.status.trim();
      const cls = s.includes('?') || s.includes('A') ? 'gnew' : s.includes('D') ? 'gdel' : 'gmod';
      const row = document.createElement('div');
      row.className = 'grow';
      const badge = document.createElement('span');
      badge.className = `gbadge ${cls}`;
      badge.textContent = s || '·';
      row.appendChild(badge);
      row.appendChild(document.createTextNode(' ' + f.path));
      row.addEventListener('click', () => void showDiff(f.path));
      changesEl.appendChild(row);
    }
  }

  let open = false;
  return {
    isOpen: () => open,
    toggle() {
      if (open && !confirmDiscard()) return; // leaving an unsaved file
      open = !open;
      panel.classList.toggle('show', open);
      if (open) {
        // Re-root to whichever pane is focused now.
        rootPane = getActivePane();
        void loadTree();
        void loadChanges();
        editor?.focus();
      }
    },
  };
}
