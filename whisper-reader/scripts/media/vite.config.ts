import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** Bundles stage.ts -- the real reader components -- for the media capture.
 *  See scripts/media/README.md. */
export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'stage.ts'),
      formats: ['iife'],
      name: 'CalmStage',
      fileName: () => 'stage.js',
    },
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    minify: false,
  },
});
