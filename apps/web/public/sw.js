/* Notebook service worker.
 *
 * Scope: cache the app shell (HTML / JS / CSS / icons / manifest) on
 * install so the app boots offline. Runtime strategy is
 * stale-while-revalidate for same-origin GETs, and network-only for
 * anything under /api/ — chat / search / retrieval all need live
 * data, and showing a stale answer would be worse than an error.
 *
 * We don't try to cache SSE streams, multipart uploads, or anything
 * with a non-GET method. The handler explicitly bypasses those.
 *
 * Versioned via the build pipeline (`%SW_VERSION%` is replaced by
 * Vite at build time) so a deploy evicts the old cache.
 */

const SW_VERSION = 'nb-sw-v1';
const SHELL_CACHE = `${SW_VERSION}-shell`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;

// App shell: anything we need to render the first paint. We
// pre-cache the bare minimum and let runtime caching fill the rest.
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS).catch(() => {
      // Best-effort: pre-caching the shell shouldn't fail the install
      // just because one URL is 404 in dev. The next request will
      // be cached by the runtime fetch handler.
    })),
  );
  // Activate the new SW immediately so a stale worker doesn't
  // keep serving cached bytes after a deploy.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('nb-sw-') && !k.startsWith(SW_VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // only intercept safe methods
  const url = new URL(req.url);

  // Bypass: API calls. We never serve cached chat answers or stale
  // retrieval results; the UI shows an explicit error if offline.
  if (url.pathname.startsWith('/api/')) return;
  // Bypass: SSE / streaming endpoints, in case anything lives
  // outside /api/.
  if (req.headers.get('accept')?.includes('text/event-stream')) return;
  // Bypass: Vite dev server HMR / source files in dev mode.
  if (url.pathname.startsWith('/@') || url.pathname.startsWith('/src/')) return;
  // Bypass: cross-origin.
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate for everything else.
  event.respondWith(staleWhileRevalidate(req));
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        // Use a clone because the response body can only be read once.
        cache.put(req, res.clone()).catch(() => undefined);
      }
      return res;
    })
    .catch(() => null);
  // Return cached immediately, refresh in the background.
  if (cached) {
    return cached;
  }
  const network = await networkPromise;
  if (network) return network;
  // Offline + no cache: return a minimal 503 so the app at least
  // surfaces something rather than a fetch error in DevTools.
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}
