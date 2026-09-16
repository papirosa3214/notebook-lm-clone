// Bundles the api into a single self-contained dist/bundle.mjs that includes
// all workspace deps (notably @notebook/shared which we don't ship as JS).
// Output: apps/api/dist/bundle.mjs (also keeps the tsc-emitted dist/ for IDE refs).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// scripts/ lives inside apps/api/, so apiRoot = here (parent is apps/api/dist from here? no — here is apps/api/scripts)
const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const sharedRoot = resolve(apiRoot, '..', '..', 'packages', 'shared');

await build({
  entryPoints: [resolve(apiRoot, 'dist', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: resolve(apiRoot, 'dist', 'bundle.mjs'),
  external: ['better-sqlite3'],
  // Resolve workspace @notebook/shared to its actual src/ folder so esbuild
  // picks up the .ts files instead of going through the workspace symlink.
  alias: {
    '@notebook/shared': resolve(sharedRoot, 'src', 'index.ts'),
    '@notebook/shared/providers': resolve(sharedRoot, 'src', 'providers.ts'),
  },
  banner: { js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);" },
  logLevel: 'info',
});

