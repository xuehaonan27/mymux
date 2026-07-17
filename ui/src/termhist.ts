// The terminal-history pager — read-only older output from the raw ptyd
// history log (GET /termhistory), shown plain-text with ANSI stripped. A
// modal overlay (Esc closes); scrolling to the top pulls older pages and
// prepends them, preserving the viewport. Plugin-shaped: narrow opts, no
// imports of other UI modules.

export interface TermHistOpts {
  /** The workspace daemon the history lives on (multi-host: set per open). */
  getApiBase: () => string;
  toast: (msg: string) => void;
}

export interface TermHistPanel {
  open(pane: number): void;
  isOpen(): boolean;
  close(): void;
}

interface Span {
  total: number;
  offset: number;
  text: string;
}

const PAGE = 96_000;

/** Plain-text-ify raw terminal output: drop escape sequences, normalize CRLF,
 * then collapse remaining carriage-return rewrites (progress bars) to their
 * final line content. */
function normalize(raw: string): string {
  const noEsc = raw
    .replace(/\x1b\][^\x07\x1b]*?(?:\x07|\x1b\\)/g, '') // OSC (title, links…)
    .replace(/\x1b\[[0-9;:?!]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[()][0-9A-B]/g, '') // charset selects
    .replace(/\x1b[@-Z\\-_]/g, '') // other 2-byte escapes
    .replace(/\x1b\\?/g, ''); // lone ESC/ST leftovers
  const lf = noEsc.replace(/\r\n/g, '\n').replace(/\n\r/g, '\n');
  return lf
    .split('\n')
    .map((l) => (l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l))
    .join('\n');
}

export function initTermHist(opts: TermHistOpts): TermHistPanel {
  const panel = document.createElement('div');
  panel.className = 'termhist';
  document.body.appendChild(panel);
  let open = false;
  let pane = 0;
  let offset = 0; // logical start of the CURRENT first chunk
  let loading = false;
  let seq = 0;

  const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  async function fetchSpan(end?: number): Promise<Span | null> {
    const q = `&limit=${PAGE}` + (end == null ? '' : `&offset=${end}`);
    try {
      const r = await fetch(`${opts.getApiBase()}/termhistory?pane=${pane}${q}`);
      if (!r.ok) return null;
      return (await r.json()) as Span;
    } catch {
      return null;
    }
  }

  const headEl = el('div', 'termhist-hd');
  const bodyEl = document.createElement('pre');
  bodyEl.className = 'termhist-body';
  panel.replaceChildren(headEl, bodyEl);

  bodyEl.addEventListener('scroll', () => {
    if (bodyEl.scrollTop > 120 || loading || offset === 0) return;
    void (async () => {
      loading = true;
      const my = ++seq;
      const res = await fetchSpan(offset);
      loading = false;
      if (!res || my !== seq) return;
      const before = offset;
      offset = res.offset;
      if (res.offset >= before) return; // already at the beginning
      const oldH = bodyEl.scrollHeight;
      const oldTop = bodyEl.scrollTop;
      bodyEl.prepend(document.createTextNode(normalize(res.text)));
      bodyEl.scrollTop = bodyEl.scrollHeight - oldH + oldTop;
    })();
  });

  return {
    isOpen: () => open,
    close() {
      open = false;
      seq++; // in-flight older-fetches die quietly
      panel.classList.remove('show');
    },
    open(p: number) {
      pane = p;
      seq++;
      open = true;
      loading = true;
      headEl.textContent = 'history · loading…';
      bodyEl.textContent = '';
      panel.classList.add('show');
      // Steal keyboard focus from the pane: keys pressed while reading
      // history must not leak into the live pty (verified — the modal stack
      // lets unconsumed keys fall through to the focused element, and every
      // one of them would yank the pane to bottom).
      panel.tabIndex = -1;
      panel.focus();
      void (async () => {
        const my = seq;
        const res = await fetchSpan();
        loading = false;
        if (my !== seq) return;
        if (!res) {
          headEl.textContent = 'history';
          bodyEl.textContent = 'no history log for this pane (native panes only)';
          return;
        }
        offset = res.offset;
        bodyEl.textContent = normalize(res.text);
        bodyEl.scrollTop = bodyEl.scrollHeight;
        headEl.textContent = `history · pane ${p} · plain text (${res.total.toLocaleString()} bytes logged · scroll up for older)`;
      })();
    },
  };
}
