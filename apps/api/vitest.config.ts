import { defineConfig } from 'vitest/config';

/**
 * vitest in the API workspace — minimal config. The tests live under
 * src/__tests__/ and use the vitest API (`import { test, ... } from 'vitest'`)
 * so they are discovered consistently with apps/web.
 */
export default defineConfig({
  test: {
    // The API uses better-sqlite3 + sqlite-vec, which require a Node
    // environment (no jsdom). `node` is the default but be explicit.
    environment: 'node',
    // Test files use ESM (.js extensions in imports) — match the api
    // tsconfig so vite-node resolves them correctly.
    server: {
      deps: {
        inline: ['@notebook/shared'],
      },
    },
  },
});
