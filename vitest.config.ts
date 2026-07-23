import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Renderer tests are PURE .ts modules only (reducers/helpers) — no DOM,
    // no jsdom dependency. Component-level tests remain a manual-matrix item.
    include: ['packages/app/src/**/*.test.ts', 'packages/renderer/src/**/*.test.ts'],
  },
});
