// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve the apps/web root from this test file. We can't use
// `import.meta.dirname` because Vitest sets that to the test
// file's directory, which is src/lib/pwa/ — we need to go up to
// the apps/web root to read index.html and public/.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, '..', '..', '..');

function read(rel: string): string {
  return readFileSync(join(WEB_ROOT, rel), 'utf8');
}

describe('PWA manifest', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
    name: string;
    short_name: string;
    start_url: string;
    display: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    theme_color: string;
    background_color: string;
  };

  it('has the required PWA fields', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('declares at least one icon plus a maskable variant', () => {
    const purposes = new Set(manifest.icons.map((i) => i.purpose));
    expect(purposes.has('any')).toBe(true);
    expect(purposes.has('maskable')).toBe(true);
  });

  it('icons are served from /icons/ and use the right paths', () => {
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/icons/')).toBe(true);
      expect(icon.type).toBe('image/svg+xml');
    }
  });
});

describe('service worker', () => {
  const sw = read('public/sw.js');

  it('declares a versioned cache name so deploys can evict', () => {
    expect(sw).toMatch(/const\s+SW_VERSION\s*=\s*['"][^'"]+['"]/);
  });

  it('bypasses /api/ requests (chat must not serve stale data)', () => {
    expect(sw).toMatch(/url\.pathname\.startsWith\(['"]\/api\/['"]\)/);
  });

  it('bypasses streaming endpoints', () => {
    expect(sw).toMatch(/text\/event-stream/);
  });

  it('uses stale-while-revalidate for everything else', () => {
    expect(sw).toMatch(/stale-while-revalidate|staleWhileRevalidate/i);
  });
});

describe('HTML document', () => {
  const html = read('index.html');

  it('links the manifest', () => {
    expect(html).toMatch(/<link[^>]+rel=["']manifest["'][^>]+href=["']\/manifest\.webmanifest["']/);
  });

  it('declares apple-mobile-web-app-capable for iOS install', () => {
    expect(html).toMatch(/apple-mobile-web-app-capable/);
  });

  it('uses viewport-fit=cover so safe-area-inset works on notched devices', () => {
    expect(html).toMatch(/viewport-fit=cover/);
  });

  it('disables telephone auto-linking on iOS', () => {
    expect(html).toMatch(/format-detection/);
  });
});
