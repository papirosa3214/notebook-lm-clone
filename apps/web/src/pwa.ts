/**
 * Service-worker registration. Idempotent: called once at boot, the
 * browser handles the actual cache updates. We swallow every error
 * because a failed registration must never break the app (e.g.
 * Safari private mode, third-party-cookie-blocking browsers).
 *
 * Test seam: `__disableServiceWorker` on globalThis turns the
 * registration into a no-op. Vitest's jsdom doesn't implement
 * `navigator.serviceWorker` and we want explicit control over
 * whether the test exercises the registration path at all.
 */

interface PwaGlobal {
  __disableServiceWorker?: boolean;
}

export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  const g = globalThis as unknown as PwaGlobal;
  if (g.__disableServiceWorker) return;
  if (!('serviceWorker' in navigator)) return;
  // Vite injects `import.meta.env.PROD` at build time; in dev we
  // skip registration to avoid HMR + service-worker interaction
  // (the dev server restarts invalidate the cache and HMR can
  // race with the worker's fetch handler).
  if (!import.meta.env.PROD) return;

  // Defer registration to the next idle slot so it doesn't compete
  // with the initial React render.
  const register = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[pwa] service worker registration failed:', err);
      });
  };
  if ('requestIdleCallback' in window) {
    (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(
      register,
    );
  } else {
    setTimeout(register, 0);
  }
}
