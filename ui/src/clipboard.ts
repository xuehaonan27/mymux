// Clipboard writes that work everywhere we render: navigator.clipboard for
// secure contexts, and a transient-textarea execCommand('copy') fallback for
// the Tauri webview (custom scheme = non-secure context, where the modern API
// fails SILENTLY in many builds — the bug the user hit). Never swallows
// errors: callers own the failure feedback.

/** true when the text landed on the system clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through to the legacy path (WKWebView non-secure contexts)
  }
  try {
    // The fallback steals focus to its transient textarea; remember whoever
    // had it (usually the terminal) so typing doesn't die until a click.
    const prev = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (prev instanceof HTMLElement) prev.focus();
    return ok;
  } catch {
    return false;
  }
}
