import { defineConfig } from '@playwright/test';

/**
 * E2E configuration.
 * Assumes the dev stack is already running locally:
 *   - Vite web on http://localhost:5273
 *   - Fastify API on http://localhost:4001
 *   - Ollama reachable from API at 192.168.1.110:11434
 *
 * If webServer is enabled here it would auto-boot the stack, but that
 * fights with the long-running nohup processes Maks uses for hot-reload.
 * We deliberately leave webServer off and require the dev stack to be up.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:5273',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        viewport: { width: 1280, height: 800 },
        // Strict-mode in dev catches the "loader spins forever" regression
        // we just fixed. In CI we can flip this off; locally it's gold.
        contextOptions: {},
      },
    },
  ],
});
