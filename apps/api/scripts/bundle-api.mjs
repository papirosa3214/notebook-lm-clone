// Bundles the api into a single self-contained dist/bundle.mjs.
// @notebook/shared is compiled to real JS by its own `build` script and inlined
// here through normal package resolution (no alias needed).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// scripts/ lives inside apps/api/
const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');

await build({
  entryPoints: [resolve(apiRoot, 'dist', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: resolve(apiRoot, 'dist', 'bundle.mjs'),
  // better-sqlite3 is a native addon — must be required at runtime, not inlined.
  external: ['better-sqlite3'],
  banner: { js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);" },
  logLevel: 'info',
});


