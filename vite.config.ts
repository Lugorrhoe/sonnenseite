import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /<repo>/ without configuration.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
