import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend dev server target (Fastify defaults to PORT=3000 / HOST=127.0.0.1).
// Override with BACKEND_ORIGIN when the backend runs elsewhere during dev.
const backendTarget = process.env.BACKEND_ORIGIN ?? 'http://localhost:3000';

// Dev-only proxy. In production the built static files are served by nginx at
// the SAME origin as the API, so no proxy is needed and VITE_API_BASE stays
// empty (relative paths). These rules only affect `vite dev`.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // WebSocket upgrade for the realtime client. Must be declared before the
      // broader '/api' rule so the ws option applies.
      '/api/v1/ws': {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/healthz': { target: backendTarget, changeOrigin: true },
      '/readyz': { target: backendTarget, changeOrigin: true },
      '/docs': { target: backendTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Split rarely-changing vendor libraries into their own long-cached chunk.
    // App code changes often (cache-busted on every deploy); React/router/query
    // do not, so returning visitors re-use the cached vendor chunk and only
    // re-download the small app + route chunks.
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query'],
        },
      },
    },
  },
});
