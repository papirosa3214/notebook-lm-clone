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

// Register the service worker in production only — Vite's HMR +
// service workers don't mix well in dev, and we want predictable
// cache behaviour when iterating. Tests stub the global navigator
// before importing this file, so the helper handles a missing
// `serviceWorker` gracefully.
registerServiceWorker();
