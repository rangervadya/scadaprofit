import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const backend = process.env.VDGO_BACKEND_URL ?? 'http://127.0.0.1:8765';
const backendProxy = {
  target: backend,
  changeOrigin: true,
  rewrite: (requestPath: string) => requestPath.replace(/^\/vdgo/, ''),
};

export default defineConfig({
  root: appRoot,
  base: '/vdgo/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/vdgo/api': backendProxy,
      '/vdgo/legacy': backendProxy,
      '/vdgo/health': backendProxy,
      '/vdgo/generate': backendProxy,
      '/vdgo/generate_docx': backendProxy,
      '/vdgo/preview': backendProxy,
    },
  },
  build: {
    outDir: path.join(appRoot, 'build'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
})
