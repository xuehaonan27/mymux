// Viewer registry — plugin-system P2. Built-in viewers register here; the
// shape deliberately mirrors what a future `kind: "viewer"` package would
// provide (docs/PKG-SPEC.md), so third-party viewers are a loader away, not
// a redesign. Viewers take over when a file can't open as text (binary /
// too large); real errors (404 etc.) still fall through to the placeholder.

export interface ViewerCtx {
  apiBase: string;
  pane: number | null;
  path: string;
  /** URL serving the file's raw bytes (optionally just a prefix). */
  rawUrl(limit?: number): string;
}

export interface Viewer {
  name: string;
  matches(path: string): boolean;
  /** Render into `mount` (already emptied). May be async. */
  render(ctx: ViewerCtx, mount: HTMLElement): void | Promise<void>;
}

const registry: Viewer[] = [];

export function registerViewer(v: Viewer) {
  registry.push(v);
}

/** First registered viewer claiming the path (registration order wins). */
export function viewerFor(path: string): Viewer | null {
  return registry.find((v) => v.matches(path)) ?? null;
}

export function makeCtx(apiBase: string, pane: number | null, path: string): ViewerCtx {
  return {
    apiBase,
    pane,
    path,
    rawUrl(limit?: number) {
      const paneQ = pane != null ? `&pane=${pane}` : '';
      const lim = limit != null ? `&limit=${limit}` : '';
      return `${apiBase}/fs/raw?path=${encodeURIComponent(path)}${paneQ}${lim}`;
    },
  };
}

// ---- built-ins -------------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|avif|svg)$/i;

registerViewer({
  name: 'image',
  matches: (p) => IMAGE_EXT.test(p),
  render(ctx, mount) {
    const img = document.createElement('img');
    img.className = 'viewer-img';
    img.src = ctx.rawUrl();
    img.alt = ctx.path;
    const meta = document.createElement('div');
    meta.className = 'viewer-meta';
    img.addEventListener('load', () => {
      meta.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
    });
    img.addEventListener('error', () => {
      meta.textContent = 'could not load the image';
    });
    mount.append(img, meta);
  },
});

registerViewer({
  name: 'pdf',
  matches: (p) => /\.pdf$/i.test(p),
  render(ctx, mount) {
    // WKWebView (Tauri on macOS) renders PDFs natively in an <embed>;
    // engines that can't will show the plugin-less gray box — the hex
    // fallback stays a click away by reopening.
    const embed = document.createElement('embed');
    embed.className = 'viewer-pdf';
    embed.src = ctx.rawUrl();
    embed.type = 'application/pdf';
    mount.append(embed);
  },
});

const HEX_BYTES = 4096;

registerViewer({
  name: 'hex',
  // The binary fallback: claims anything the text editor rejected.
  matches: () => true,
  async render(ctx, mount) {
    const pre = document.createElement('pre');
    pre.className = 'viewer-hex';
    pre.textContent = 'loading…';
    const meta = document.createElement('div');
    meta.className = 'viewer-meta';
    mount.append(pre, meta);
    try {
      const r = await fetch(ctx.rawUrl(HEX_BYTES));
      if (!r.ok) throw new Error(String(r.status));
      const total = Number(r.headers.get('x-file-size') ?? 0);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const lines: string[] = [];
      for (let off = 0; off < bytes.length; off += 16) {
        const chunk = bytes.subarray(off, off + 16);
        const hex = [...chunk]
          .map((b, i) => b.toString(16).padStart(2, '0') + (i === 7 ? ' ' : ''))
          .join(' ');
        const ascii = [...chunk]
          .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·'))
          .join('');
        lines.push(
          `${off.toString(16).padStart(8, '0')}  ${hex.padEnd(48 + 2)}  ${ascii}`,
        );
      }
      pre.textContent = lines.join('\n') || '(empty file)';
      meta.textContent =
        total > bytes.length
          ? `first ${bytes.length} bytes of ${total.toLocaleString()}`
          : `${total.toLocaleString()} bytes`;
    } catch {
      pre.textContent = 'could not read the file';
    }
  },
});
