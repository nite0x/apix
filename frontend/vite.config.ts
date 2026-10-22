import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  base: command === 'serve' ? '/' : '/activity/ui/',
  build: { outDir: '../runtime/internal/activity/web/dist', emptyOutDir: true, target: 'es2022' },
  server: {
    host: '127.0.0.1', port: 1420, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4317', '/health': 'http://127.0.0.1:4317', '/mcp': 'http://127.0.0.1:4317' },
  },
}));
