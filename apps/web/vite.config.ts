import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Same-origin API in every environment: the browser only talks to the Vite origin; /api is proxied.
// WEB_PORT / API_TARGET let the e2e and demo environments run beside the default dev stack.
const port = Number(process.env.WEB_PORT ?? 5173);
const target = process.env.API_TARGET ?? 'http://localhost:3000';
const proxy = { '/api': { target, changeOrigin: false } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: { port, strictPort: true, proxy },
  preview: { port, strictPort: true, proxy },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'], css: false },
});
