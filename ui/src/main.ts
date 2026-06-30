import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';

// M0: one pane, one connection. The daemon's WebSocket speaks:
//   binary  in  -> raw pane bytes (write straight to xterm)
//   binary  out -> raw keystroke bytes
//   text    out -> JSON control ({ type: "resize", cols, rows })
const WS_URL = `ws://${location.hostname || '127.0.0.1'}:8088/ws`;

const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  scrollback: 10000,
  cursorBlink: true,
  theme: { background: '#0b0e14', foreground: '#c5cdd9' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term')!);
fit.fit();

const statusEl = document.getElementById('status')!;
const metaEl = document.getElementById('meta')!;

let ws: WebSocket | undefined;

function setStatus(state: 'connecting' | 'open' | 'closed') {
  statusEl.className = `dot ${state}`;
  metaEl.textContent = state === 'open' ? `${term.cols}×${term.rows}` : state;
}

function sendResize() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

function connect() {
  setStatus('connecting');
  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus('open');
    sendResize();
    term.focus();
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
  };
  ws.onclose = () => {
    setStatus('closed');
    // M2 makes reconnection seamless (re-sync from daemon state); for now, retry.
    window.setTimeout(connect, 1000);
  };
  ws.onerror = () => ws?.close();
}

term.onData((data) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(new TextEncoder().encode(data));
  }
});

// Keep tmux's view sized to the actual terminal element.
new ResizeObserver(() => fit.fit()).observe(document.getElementById('term')!);
term.onResize(() => sendResize());
window.addEventListener('resize', () => fit.fit());

connect();
