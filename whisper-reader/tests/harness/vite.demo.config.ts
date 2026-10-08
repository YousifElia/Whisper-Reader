import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'demo.ts'),
      formats: ['iife'],
      name: 'CalmDemo',
      fileName: () => 'demo.js',
    },
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    minify: true,
  },
});
