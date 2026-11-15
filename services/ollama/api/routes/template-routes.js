import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { templateExtensions } from '../template-store.js';

/**
 * Template routes (P2-1): a single global style reference.
 *
 * Extracted from server.js unchanged; dependencies are injected so the module
 * has no knowledge of how the app is wired.
 */
export function createTemplateRouter({ store, uploadDir, limitHeavyRequests }) {
  const router = express.Router();

  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 30 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(String(file.originalname || '')).toLowerCase();
      cb(null, templateExtensions.has(ext));
    },
  });

  router.get('/', async (req, res) => {
    try {
      const meta = await store.readMeta();
      return res.json({ ok: true, template: store.toPublic(meta) });
    } catch (error) {
      if (error?.code === 'ENOENT') return res.json({ ok: true, template: null });
      req.log.error({ err: error }, 'Cannot read template metadata');
      return res.status(500).json({ error: 'Не удалось прочитать эталонный шаблон.' });
    }
  });

  router.get('/file', async (_req, res) => {
    try {
      const found = await store.filePath();
      if (!found) return res.status(404).json({ error: 'Эталонный шаблон ещё не загружен.' });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Always download reference files, including SVG, rather than rendering user content inline.
      // dotfiles: 'allow' — the file lives under .private/template; the store already
      // validated the name, so this is not user-controlled traversal.
      return res.download(found.absolute, found.meta.originalName, { dotfiles: 'allow' }, (error) => {
        if (error && !res.headersSent) {
          res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: 'Файл шаблона не найден.' });
        }
      });
    } catch (error) {
      _req.log.error({ err: error }, 'Cannot download template');
      return res.status(500).json({ error: 'Не удалось скачать эталонный шаблон.' });
    }
  });

  router.post('/', limitHeavyRequests, upload.single('template'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Выберите PDF, SVG, DXF, PNG, JPG, WEBP или TIFF.' });
    const ext = path.extname(String(req.file.originalname || '')).toLowerCase();
    if (!templateExtensions.has(ext)) {
      await rm(req.file.path, { force: true }).catch(() => {});
      return res.status(400).json({ error: 'Формат файла шаблона не поддерживается.' });
    }
    try {
      const meta = await store.replaceTemplate({
        sourcePath: req.file.path,
        originalName: req.file.originalname,
        size: req.file.size,
      });
      return res.status(201).json({ ok: true, template: store.toPublic(meta) });
    } catch (error) {
      req.log.error({ err: error, size: req.file?.size || 0 }, 'Cannot save uploaded template');
      return res.status(500).json({ error: 'Не удалось сохранить эталонный шаблон.' });
    } finally {
      await rm(req.file.path, { force: true }).catch(() => {});
    }
  });

  router.delete('/', async (req, res) => {
    try {
      await store.remove();
      return res.json({ ok: true, template: null });
    } catch (error) {
      req.log.error({ err: error }, 'Cannot delete template');
      return res.status(500).json({ error: 'Не удалось удалить эталонный шаблон.' });
    }
  });

  return router;
}
