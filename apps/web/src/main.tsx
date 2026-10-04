import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';
import './styles.css';
import { registerServiceWorker } from './pwa.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

// Catch render-phase errors that escape React (effect / event handlers /
// async work) and any unhandled promise rejections, so the user can be
// pointed at a stack trace in the PanelErrorBoundary fallback panel
// without leaving the page open.
const GLOBAL_ERROR_KEY = 'nb.lastGlobalError';
function recordGlobalError(kind: string, payload: unknown) {
  try {
    const err =
      payload instanceof Error
        ? { message: payload.message, stack: payload.stack ?? '' }
        : { message: String(payload), stack: '' };
    localStorage.setItem(
      GLOBAL_ERROR_KEY,
      JSON.stringify({ kind, ...err, at: new Date().toISOString() }),
    );
  } catch {
    /* quota — ignore */
  }
}
window.addEventListener('error', (e) => {
  console.error('[window.error]', e.error ?? e.message);
  recordGlobalError('error', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason);
  recordGlobalError('unhandledrejection', e.reason);
});

// Register the service worker in production only — Vite's HMR +
// service workers don't mix well in dev, and we want predictable
// cache behaviour when iterating. Tests stub the global navigator
// before importing this file, so the helper handles a missing
// `serviceWorker` gracefully.
registerServiceWorker();
