/**
 * Vite config for the React renderer.
 *
 * - `base: './'`  ensures relative asset URLs so the prod build loads from
 *   `file://` inside Electron without a server.
 * - `strictPort: true` makes a port conflict fail loudly — the `npm run dev`
 *   script in the workspace root waits on exactly :5173 before launching
 *   Electron, so a silent port shift would race the Electron window.
 * - The `@/` alias matches the tsconfig paths so editor + bundler agree.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
