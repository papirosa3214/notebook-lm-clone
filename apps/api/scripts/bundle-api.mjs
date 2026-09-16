// Bundles the api into a single self-contained dist/bundle.mjs that includes
// all workspace deps (notably @notebook/shared which we don't ship as JS).
// Output: apps/api/dist/bundle.mjs (also keeps the tsc-emitted dist/ for IDE refs).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// scripts/ lives inside apps/api/, so apiRoot = here (parent is apps/api/dist from here? no — here is apps/api/scripts)
const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');

await build({
  entryPoints: [resolve(apiRoot, 'dist', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: resolve(apiRoot, 'dist', 'bundle.mjs'),
  // Native modules like better-sqlite3 must not be bundled.
  external: ['better-sqlite3', './*.node'],
  // Keep dynamic require for optional native binaries (pdf-parse, mammoth etc).
  banner: { js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);" },
  logLevel: 'info',
});

