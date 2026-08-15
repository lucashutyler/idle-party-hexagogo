import { defineConfig } from 'vite';
import path from 'path';
// Imported by source path rather than through the `@idle-party-rpg/shared`
// alias below: the alias is applied to app code, not to the config itself,
// which vite loads before any of it takes effect. AssetKinds is pure data with
// no imports of its own, so pulling the single file in is safe here.
import { ASSET_KINDS, ASSET_KIND_INFO } from '../shared/src/assets/AssetKinds';

/** One dev proxy entry per asset mount, so artwork requests reach the server. */
function assetProxyEntries(): Record<string, { target: string; changeOrigin: boolean }> {
  return Object.fromEntries(
    ASSET_KINDS.map(kind => [
      ASSET_KIND_INFO[kind].mount,
      { target: 'http://localhost:3001', changeOrigin: true },
    ])
  );
}

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
      // Every asset mount the server serves statically needs a matching proxy
      // entry — otherwise vite swallows the request and returns the SPA
      // index.html. Derived from the shared registry so this can't drift from
      // the server's mounts the way the hand-written list used to.
      ...assetProxyEntries(),
    },
  },
  resolve: {
    alias: {
      '@idle-party-rpg/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
});
