import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// The dev server needs React Refresh's inline preamble, so the CSP is only added to production builds.
const productionCsp: Plugin = {
  name: 'free-code-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
      "font-src 'self' data:",
      "img-src 'self' data:",
    ].join('; ');
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
  },
};

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react(), productionCsp],
  server: { port: 5173, strictPort: true },
  build: {
    chunkSizeWarningLimit: 6000,
    outDir: resolve(import.meta.dirname, 'out/renderer'),
    emptyOutDir: true,
  },
});
