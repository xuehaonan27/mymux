// Shared sandbox for ux checks: an isolated ptyd+mymuxd pair with its own
// unix socket, tmux socket, and port — never a shared/production daemon
// (cross-run state pollution produced most of our phantom failures). Usage:
//   const sb = await startSandbox(8095, 'emoji');
//   ... drive UI at ?port=8095 ...
//   sb.kill();
// plan A of the robustness program: every daemon-touching check goes
// through this (the inline copies in winswitch/hostroute/reconnect migrate
// here next).
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const BIN = '/home/xuehaonan/mymux/target/debug';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startSandbox(port, name) {
  const sock = `/tmp/mymux-ux-${name}.sock`;
  rmSync(sock, { force: true });
  const env = {
    ...process.env,
    MYMUX_PTYD_SOCK: sock,
    MYMUX_SOCKET: `mymux-ux-${name}`,
    MYMUX_ADDR: `127.0.0.1:${port}`,
  };
  const procs = [spawn(`${BIN}/mymux-ptyd`, [], { env, stdio: 'ignore' })];
  for (let i = 0; i < 50 && !existsSync(sock); i++) await sleep(100);
  if (!existsSync(sock)) throw new Error(`sandbox ptyd did not come up on ${sock}`);
  procs.push(spawn(`${BIN}/mymuxd`, [], { env, stdio: 'ignore' }));
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/git/toplevel?root=/home/xuehaonan`);
      if (r.ok) {
        return {
          port,
          sock,
          ui: `http://127.0.0.1:5173/?port=${port}`,
          kill() {
            for (const p of procs) p.kill();
            rmSync(sock, { force: true });
          },
        };
      }
    } catch { /* still booting */ }
    await sleep(100);
  }
  for (const p of procs) p.kill();
  throw new Error(`sandbox daemon did not come up on :${port}`);
}
