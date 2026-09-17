import { defineConfig } from 'vitest/config';

/**
 * Vitest is for unit tests only. E2E specs under `e2e/` are run via
 * `pnpm test:e2e` (Playwright) — not vitest — because they need a real
 * browser and the running dev stack. Including them in vitest causes
 * failures (Playwright's `test` import isn't available there) and slows
 * down the unit-test feedback loop.
 */
export default defineConfig({
  test: {
    exclude: ['node_modules', 'dist', 'e2e/**'],
  },
});
