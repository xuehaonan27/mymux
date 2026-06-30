import { defineConfig } from 'vite';

// M0: UI is served by Vite in dev and talks to mymuxd's WebSocket directly.
// From M2 the daemon serves the built bundle and there is no separate port.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },
});
