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
  // Native addon and CJS-only worker packages load from node_modules at runtime
  // (bundling them into ESM breaks their __dirname / worker-thread resolution).
  external: ['better-sqlite3', 'pino-pretty'],
  banner: { js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);" },
  logLevel: 'info',
});


