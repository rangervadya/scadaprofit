import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const mainBackend = process.env.MAIN_BACKEND_URL ?? 'http://127.0.0.1:3000';
const vdgoBackend = process.env.VDGO_BACKEND_URL ?? 'http://127.0.0.1:8765';
const vdgoProxy = {
  target: vdgoBackend,
  changeOrigin: true,
  rewrite: (requestPath: string) => requestPath.replace(/^\/vdgo/, ''),
};

export default defineConfig({
  root: appRoot,
  base: '/vdgo/',
  publicDir: false,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/vdgo/api': vdgoProxy,
      '/vdgo/health': vdgoProxy,
      '/vdgo/generate_docx': vdgoProxy,
      '/vdgo/generate': vdgoProxy,
      '/vdgo/preview': vdgoProxy,
      '/vdgo/reports': vdgoProxy,
      '/api': { target: mainBackend, changeOrigin: true },
      '/jobs': { target: mainBackend, changeOrigin: true },
    },
  },
  build: {
    outDir: path.join(appRoot, 'public/vdgo'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-router')) return 'router';
          if (id.includes('react')) return 'react-vendor';
          return 'vendor';
        },
      },
    },
  },
});