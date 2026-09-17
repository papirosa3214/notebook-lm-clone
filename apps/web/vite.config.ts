import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';

const API_TARGET = 'http://localhost:4001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // SSE through node-http-proxy buffers responses by default — the
        // browser only sees the full stream once the upstream closes,
        // which makes chat/summary look hung while the model loads or
        // thinks. selfHandleResponse + manual pipe bypasses that buffer
        // and flushes each chunk to the browser immediately.
        selfHandleResponse: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq: ClientRequest, req: IncomingMessage) => {
            // Forward the abort so cancelling a stream on the client
            // actually tears down the upstream HTTP request.
            req.on('close', () => {
              if (!proxyReq.destroyed) proxyReq.destroy();
            });
          });
          proxy.on(
            'proxyRes',
            (proxyRes: IncomingMessage, req: IncomingMessage, res: ServerResponse) => {
              // Strip any proxy-imposed hop-by-hop / encoding that would
              // re-buffer the response. SSE is always identity-encoded.
              const headers = { ...proxyRes.headers };
              delete headers['content-length'];
              delete headers['content-encoding'];
              delete headers['transfer-encoding'];
              headers['x-accel-buffering'] = 'no';
              res.writeHead(proxyRes.statusCode ?? 502, headers);
              proxyRes.pipe(res);
              proxyRes.on('end', () => res.end());
              proxyRes.on('error', (err) => {
                // Surface the upstream error instead of hanging the
                // browser's EventSource.
                try {
                  res.end();
                } catch {
                  /* socket already closed */
                }
                console.error('[vite-proxy] upstream error:', err);
              });
            },
          );
        },
      },
    },
  },
});