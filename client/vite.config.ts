import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        admin: path.resolve(__dirname, 'admin.html'),
      },
    },
  },
  // Rewrite /admin routes to admin.html in dev (SPA fallback for multi-page app)
  plugins: [{
    name: 'admin-spa-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && req.url.startsWith('/admin') && !req.url.includes('.')) {
          req.url = '/admin.html';
        }
        next();
      });
    },
  }],
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/auth': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Every artwork kind served by the server's express static mounts
      // needs a matching proxy entry — otherwise vite swallows the request
      // and returns the SPA index.html. Keep this list in sync with the
      // static mounts in server/src/index.ts.
      '/item-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/monster-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/class-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/tile-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/tile-type-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/set-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/shop-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/zone-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/logo-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/parchment-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/combat-bg-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/room-bg-artwork': { target: 'http://localhost:3001', changeOrigin: true },
      '/nav-icons': { target: 'http://localhost:3001', changeOrigin: true },
      '/class-icons': { target: 'http://localhost:3001', changeOrigin: true },
      '/slot-icons': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      '@idle-party-rpg/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
});
