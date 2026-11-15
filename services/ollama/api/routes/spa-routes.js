import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * SPA fallback routes (P2-1).
 *
 * The React application is the only active frontend and is built into
 * frontend/public/vdgo/. Unknown browser routes redirect to it; API and file
 * routes keep their own handlers and never receive an HTML fallback.
 */
export function createSpaRouter({ publicDir } = {}) {
  const router = express.Router();
  const spaRoot = publicDir || path.join(__dirname, '../../../../frontend/public');

  router.get('/vdgo', (_req, res) => res.redirect(308, '/vdgo/'));
  router.get(/^\/vdgo(?:\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(spaRoot, 'vdgo/index.html'), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  });

  // Unknown browser routes are sent to the unified SPA.
  router.get(/^(?!\/api(?:\/|$)|\/jobs(?:\/|$))/, (_req, res) => res.redirect(308, '/vdgo/'));

  return router;
}
