import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.VDGO_BACKEND_URL ?? 'http://127.0.0.1:8765';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': backend,
      '/legacy': backend,
      '/health': backend,
      '/generate': backend,
      '/generate_docx': backend,
      '/preview': backend,
    },
  },
  build: { sourcemap: false, target: 'es2022' },
});
