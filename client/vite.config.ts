import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 3000,
    open: true,
  },
  resolve: {
    alias: {
      '@idle-party-rpg/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
});
