import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI is built into dist/web and served by the daemon. `npm run dev:web` proxies /api to a running daemon.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { port: 5178, proxy: { '/api': 'http://127.0.0.1:7878' } },
});
