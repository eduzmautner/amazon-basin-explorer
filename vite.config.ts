import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/, so production builds use that base path.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/amazon-basin-explorer/' : '/',
}));
