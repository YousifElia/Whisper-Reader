import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'probe.ts'),
      formats: ['iife'],
      name: 'CalmProbe',
      fileName: () => 'probe.js',
    },
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    minify: true,
  },
});
