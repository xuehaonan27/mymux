// Path-token parsing + daemon probing for jump-to-path gestures (terminal
// ⌘+click links, editor ⌘+click, the ⌘P path row). All resolution goes
// through the same probes so every entry point agrees on what counts.

export interface ParsedToken {
  path: string;
  line?: number;
  col?: number;
}

/** "src/a.rs:33:7" → { path: 'src/a.rs', line: 33, col: 7 }. A trailing
 * :N[:M] suffix is only stripped when it follows something path-like (has a
 * slash or a dot), so "std::io" and "v0.1.0" stay whole. */
export function parseToken(raw: string): ParsedToken | null {
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (m && /[/.]/.test(m[1])) {
    return { path: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined };
  }
  return { path: t };
}

/** Lexically normalize an absolute path (resolve . and .. without touching
 * the fs; the daemon canonicalizes again on its side). */
export function normalizeAbs(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

export const parentOf = (abs: string) => {
  const p = abs.replace(/\/+$/, '').replace(/\/[^/]*$/, '');
  return p || '/';
};
export const baseOf = (abs: string) => abs.slice(parentOf(abs) === '/' ? 1 : parentOf(abs).length + 1);

export interface JumpTarget {
  abs: string;
  dir: boolean;
}

/** Does this absolute path exist (and is it a dir)? The naive "does
 * /fs/list answer" test DOESN'T work: the daemon falls back to the pane root
 * when the override isn't a directory, so a FILE path returns a happy 200
 * listing of the daemon's cwd (e2e caught it — a file "jumped" as a dir).
 * Instead ask /fs/root what root it HONORED for this override: an exact echo
 * means a real directory (symlinked dirs can miss here — canonicalization
 * differs; they degrade to a failed probe, not a wrong jump). Files then
 * probe through /fs/raw (1 byte; its 400 means "exists but over the cap"). */
export async function probePath(apiBase: string, abs: string): Promise<JumpTarget | null> {
  try {
    const jr = await fetch(`${apiBase}/fs/root?root=${encodeURIComponent(abs)}`);
    if (jr.ok) {
      const j = (await jr.json()) as { root?: string };
      if (j.root === abs) return { abs, dir: true };
    }
    const parent = parentOf(abs);
    const rr = await fetch(
      `${apiBase}/fs/raw?root=${encodeURIComponent(parent)}&path=${encodeURIComponent(baseOf(abs))}&limit=1`,
    );
    if (rr.ok || rr.status === 400) return { abs, dir: false };
    return null;
  } catch {
    return null;
  }
}

/** Resolve a user/token path (absolute or base-relative) to a probe result. */
export async function resolvePath(
  apiBase: string,
  base: string,
  raw: string,
): Promise<JumpTarget | null> {
  const abs = normalizeAbs(raw.startsWith('/') ? raw : `${base.replace(/\/+$/, '')}/${raw}`);
  return probePath(apiBase, abs);
}

/** A pane's cwd via the fs root endpoint ("" when pane is null/absent). */
export async function paneRoot(apiBase: string, pane: number | null): Promise<string | null> {
  try {
    const r = await fetch(`${apiBase}/fs/root?${pane != null ? `pane=${pane}&` : ''}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { root?: string };
    return j.root ?? null;
  } catch {
    return null;
  }
}

/** Path-ish spans in a line of terminal/editor text, for link providers.
 * Covers ./x, ../x, /abs, rel/with/slashes, and bare ext-files, each with an
 * optional :line[:col] suffix (compiler-error style: "./a/b.rs:33:7" keeps
 * the numbers). A URL-ish "//host:8080" may catch a spurious :8080 — false
 * positives cost one failed probe, acceptable because clicking is always a
 * deliberate, modifier-held act. */
export interface PathSpan {
  start: number;
  len: number;
  raw: string;
}
const SPAN_RE =
  /(?:\.{1,2}\/[\w.~/+-]+|\/[\w.~/+-]+|[\w-]+(?:\/[\w.~+-]+)+|[\w+-][\w.+-]*\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?/g;

export function pathSpans(line: string): PathSpan[] {
  const out: PathSpan[] = [];
  SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN_RE.exec(line))) {
    out.push({ start: m.index, len: m[0].length, raw: m[0] });
    // exec advances by the match; overlapping alternatives are fine.
    if (m[0].length === 0) SPAN_RE.lastIndex++;
  }
  return out;
}
