import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = 'http://localhost:4001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Default http-proxy behaviour works fine for normal JSON endpoints
      // and SSE — Vite/node-http-proxy handles flushing well enough for our
      // case. If we ever see SSE-buffering symptoms on a specific endpoint,
      // add `configure(proxy)` here with a chunked passthrough for that path.
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});