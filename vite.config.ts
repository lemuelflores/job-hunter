import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./src/web/', import.meta.url)),
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, request) => {
            // Preserve the backend origin check across the same-origin dev proxy.
            if (request.headers.origin === `http://${request.headers.host}`)
              outgoing.setHeader('origin', 'http://127.0.0.1:3000');
          });
        },
      },
    },
  },
});
