import { EditorView, basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { rust } from '@codemirror/lang-rust';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';

const API = 'http://127.0.0.1:8088';

// Make the editor fill its (bounded) parent AND scroll on wheel/trackpad — this
// has to be a CodeMirror theme, not just CSS, or the scroller never enables.
const editorTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { overflow: 'auto' },
});

interface FsEntry {
  name: string;
  dir: boolean;
  size: number;
}
interface GitFile {
  status: string;
  path: string;
}

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

// One code view per pane. The tree, the changes list and the editor are all
// rooted at the same pane cwd, so they live together in a Session rather than
// as separate loose variables that have to be reset in lockstep by hand.
interface Session {
  pane: number | null;
  path: string | null; // file open in the editor, or null
  savedDoc: string; // last saved contents (dirty = editor doc differs)
  state: EditorState | null; // editor doc + history, preserved across pane switches
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
      <div class="code-side-hd">files</div>
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
  const sessions = new Map<number, Session>();
  let current: Session | null = null;
  let open = false;

  const keyOf = (p: number | null) => p ?? -1;
  function sessionFor(p: number | null): Session {
    const k = keyOf(p);
    let s = sessions.get(k);
    if (!s) {
      s = { pane: p, path: null, savedDoc: '', state: null };
      sessions.set(k, s);
    }
    return s;
  }

  // Derived, never stored — the single source of "unsaved?" truth.
  const isDirty = () =>
    !!(current?.path && editor && editor.state.doc.toString() !== current.savedDoc);

  function renderHeader() {
    if (!current?.path) {
      pathEl.textContent = 'no file open';
      pathEl.style.color = '';
      return;
    }
    const d = isDirty();
    pathEl.textContent = (d ? '● ' : '') + current.path;
    pathEl.style.color = d ? '#d6a04c' : '';
  }

  // Opening a different file is the only place edits are actually discarded;
  // closing the panel and switching panes both preserve the session.
  const confirmDiscard = () =>
    !isDirty() || window.confirm(`Discard unsaved changes to ${current!.path}?`);

  // Placeholder shown when a pane has no file open — read-only so it can't be
  // mistaken for an editable buffer.
  const emptyState = () =>
    EditorState.create({
      doc: '',
      extensions: [basicSetup, oneDark, editorTheme, EditorView.editable.of(false)],
    });

  function fileState(path: string, doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        oneDark,
        editorTheme,
        langFor(path),
        keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (void save(), true) }]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) renderHeader();
        }),
      ],
    });
  }

  function mount(state: EditorState) {
    if (editor) editor.setState(state);
    else editor = new EditorView({ state, parent: editorParent });
    editorParent.style.display = '';
    diffEl.style.display = 'none';
  }

  async function save() {
    if (!editor || !current?.path) return;
    const s = current;
    const doc = editor.state.doc.toString();
    const ok = await fsWrite(s.pane, s.path!, doc);
    if (ok) {
      s.savedDoc = doc;
      const p = s.path;
      pathEl.textContent = `${p}   ✓ saved`;
      setTimeout(() => {
        if (current === s && current.path === p) renderHeader();
      }, 1200);
    } else {
      pathEl.textContent = `${s.path}   ✗ save failed`;
    }
  }

  async function openFile(path: string) {
    if (!current || !confirmDiscard()) return;
    const s = current;
    let content: string;
    try {
      content = await fsRead(s.pane, path);
    } catch {
      pathEl.textContent = `cannot open ${path} (binary or too large?)`;
      return;
    }
    if (current !== s) return; // switched panes mid-read
    s.path = path;
    s.savedDoc = content;
    s.state = fileState(path, content);
    mount(s.state);
    renderHeader();
    editor!.focus();
  }

  // The diff is a transient view over the current pane; it leaves the editor
  // session untouched, so switching back restores the open file and its edits.
  async function showDiff(path: string) {
    if (!current) return;
    const s = current;
    pathEl.textContent = `diff · ${path}`;
    pathEl.style.color = '';
    const text = (await gitDiff(s.pane, path)) || '(no textual diff)';
    if (current !== s) return;
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
      let expanded = false;
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        expanded = !expanded;
        row.textContent = (expanded ? '▾ ' : '▸ ') + name;
        kids.style.display = expanded ? '' : 'none';
        if (expanded && !loaded) {
          loaded = true;
          for (const c of await fsList(current?.pane ?? null, path)) {
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
    const s = current;
    treeEl.replaceChildren();
    const items = await fsList(s?.pane ?? null, '');
    if (current !== s) return; // switched panes mid-fetch
    for (const c of items) treeEl.appendChild(treeItem(c.name, c.name, c.dir, 0));
  }

  async function loadChanges() {
    const s = current;
    const files = await gitStatus(s?.pane ?? null);
    if (current !== s) return;
    changesEl.replaceChildren();
    if (!files.length) {
      changesEl.textContent = 'clean';
      return;
    }
    for (const f of files) {
      const st = f.status.trim();
      const cls = st.includes('?') || st.includes('A') ? 'gnew' : st.includes('D') ? 'gdel' : 'gmod';
      const row = document.createElement('div');
      row.className = 'grow';
      const badge = document.createElement('span');
      badge.className = `gbadge ${cls}`;
      badge.textContent = st || '·';
      row.appendChild(badge);
      row.appendChild(document.createTextNode(' ' + f.path));
      row.addEventListener('click', () => void showDiff(f.path));
      changesEl.appendChild(row);
    }
  }

  // Swap the whole view to a pane's session: snapshot the outgoing editor, then
  // restore (or create) the incoming one. This is the only place "which pane"
  // changes, so there is nothing to reset by hand elsewhere.
  function showSession(p: number | null) {
    if (current && editor) current.state = editor.state; // snapshot outgoing edits
    current = sessionFor(p);
    mount(current.state ?? emptyState());
    renderHeader();
    void loadTree();
    void loadChanges();
    editor?.focus();
  }

  return {
    isOpen: () => open,
    toggle() {
      if (open) {
        // Closing preserves the session (edits live on for the next open), so
        // there is nothing to discard here.
        open = false;
        panel.classList.remove('show');
        return;
      }
      open = true;
      panel.classList.add('show');
      showSession(getActivePane());
    },
  };
}
