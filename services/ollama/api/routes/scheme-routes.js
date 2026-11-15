import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, copyFile } from 'node:fs/promises';

/**
 * Scheme routes (P2-1): upload, read, status, analyze, save.
 *
 * These depend on the analysis queue (`enqueueStoredSchemeAnalysis`) and on the
 * job directory layout, so the dependencies are injected rather than imported.
 */
export function createSchemeRouter({
  dataDir,
  readAddressLibrary,
  updateAddressLibrary,
  findBuilding,
  addSchemeToBuilding,
  findScheme,
  readSchemeMeta,
  writeSchemeMeta,
  enqueueStoredSchemeAnalysis,
  cleanLabel,
  limitHeavyRequests,
  heavyQuota,
  upload,
  shortJobId,
  JOB_ID_PATTERN,
  UUID_PATTERN,
}) {
  const router = express.Router();

  // Upload stores the original in the selected house and automatically queues
  // its reconstruction. The GPU queue serializes Qwen jobs to protect VRAM.
  router.post('/upload', limitHeavyRequests, heavyQuota, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Загрузите JPG, PNG, WEBP или TIFF.' });
    const streetId = String(req.body?.streetId || '');
    const buildingId = String(req.body?.buildingId || '');
    const uploadedBy = cleanLabel(req.body?.uploadedBy, 80);
    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
    const originalName = cleanLabel(path.basename(req.file.originalname || 'Эскиз'), 180) || 'Эскиз';
    const title = cleanLabel(req.body?.title || path.basename(originalName, ext), 140) || 'Новый эскиз';

    if (!UUID_PATTERN.test(streetId) || !UUID_PATTERN.test(buildingId)) {
      await rm(req.file.path, { force: true }).catch(() => {});
      return res.status(400).json({ error: 'Сначала найди улицу и выбери номер дома.' });
    }

    const jobId = randomUUID();
    const jobDir = path.join(dataDir, jobId);
    const sourceName = `source${ext}`;
    try {
      const library = await readAddressLibrary();
      const address = findBuilding(library, streetId, buildingId);
      if (!address) {
        await rm(req.file.path, { force: true }).catch(() => {});
        return res.status(404).json({ error: 'Адрес не найден. Обнови поиск улиц и домов.' });
      }
      await mkdir(jobDir, { recursive: true });
      await copyFile(req.file.path, path.join(jobDir, sourceName));
      await rm(req.file.path, { force: true });

      const requestedRotation = String(req.body?.rotationDegrees ?? 'auto');
      const rotationDegrees = ['0', '90', '180', '270'].includes(requestedRotation) ? Number(requestedRotation) : null;
      const meta = {
        jobId,
        title,
        originalName,
        sourceName,
        uploadedBy,
        rotationDegrees,
        streetId,
        streetName: address.street.name,
        buildingId,
        buildingName: address.building.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'pending',
        error: '',
      };
      await writeSchemeMeta(jobId, meta);
      await updateAddressLibrary((current) => {
        const target = findBuilding(current, streetId, buildingId);
        if (!target) {
          const error = new Error('Адрес удалён во время отправки.');
          error.status = 404;
          throw error;
        }
        addSchemeToBuilding(current, target.street, target.building, {
          jobId,
          title,
          originalName,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          uploadedBy,
          sourceName,
          status: 'pending',
          error: '',
        });
      });
      const analysisStatus = await enqueueStoredSchemeAnalysis(jobId);
      return res.status(201).json({
        ok: true,
        scheme: { ...meta, status: analysisStatus, sourceUrl: `/jobs/${jobId}/${sourceName}` },
        library: await readAddressLibrary(),
      });
    } catch (error) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});
      return res
        .status(error.status || 500)
        .json({ error: error.message || 'Не удалось отправить эскиз в папку дома.' });
    } finally {
      if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
    }
  });

  router.get('/:jobId', async (req, res) => {
    const { jobId } = req.params;
    if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID схемы.' });
    try {
      const library = await readAddressLibrary();
      const found = findScheme(library, jobId);
      if (!found) return res.status(404).json({ error: 'Схема не найдена в библиотеке адресов.' });
      const meta = await readSchemeMeta(jobId);
      if (!meta?.sourceName) return res.status(404).json({ error: 'Исходная фотография не найдена.' });
      const scheme = {
        ...found.scheme,
        streetName: found.street.name,
        buildingName: found.building.name,
        sourceUrl: `/jobs/${jobId}/${path.basename(meta.sourceName)}`,
        progressUrl: `/jobs/${jobId}/progress.log`,
      };
      return res.json({ ok: true, scheme });
    } catch (error) {
      req.log.error({ err: error, jobId: shortJobId(jobId) }, 'Cannot open stored scheme');
      return res.status(500).json({ error: error.message || 'Не удалось открыть схему.' });
    }
  });

  router.get('/:jobId/status', async (req, res) => {
    const { jobId } = req.params;
    if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID схемы.' });
    try {
      const library = await readAddressLibrary();
      const found = findScheme(library, jobId);
      if (!found) return res.status(404).json({ error: 'Схема не найдена.' });
      const meta = await readSchemeMeta(jobId);
      let progress = '';
      try {
        const raw = await readFile(path.join(dataDir, jobId, 'progress.log'), 'utf8');
        progress = raw.trim().split(/\r?\n/).slice(-1)[0] || '';
      } catch {
        /* pending upload has no processing log yet */
      }
      return res.json({
        ok: true,
        jobId,
        status: meta?.status || found.scheme.status || 'completed',
        progress,
        error: meta?.error || found.scheme.error || '',
        queuePosition: meta?.queuePosition || null,
        graphReady: await readFile(path.join(dataDir, jobId, 'graph.json'))
          .then(() => true)
          .catch(() => false),
      });
    } catch (error) {
      req.log.error({ err: error, jobId: shortJobId(jobId) }, 'Cannot read scheme status');
      return res.status(500).json({ error: error.message || 'Не удалось проверить состояние схемы.' });
    }
  });

  router.post('/:jobId/analyze', limitHeavyRequests, heavyQuota, async (req, res) => {
    const { jobId } = req.params;
    if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID схемы.' });
    try {
      const library = await readAddressLibrary();
      const found = findScheme(library, jobId);
      if (!found) return res.status(404).json({ error: 'Сначала отправь эскиз в папку нужного дома.' });
      const meta = await readSchemeMeta(jobId);
      if (!meta?.sourceName) return res.status(404).json({ error: 'Исходная фотография не найден.' });
      if (meta.status === 'completed') return res.json({ ok: true, status: 'completed', jobId });
      const status = await enqueueStoredSchemeAnalysis(jobId);
      return res.status(202).json({ ok: true, status, jobId });
    } catch (error) {
      req.log.error({ err: error, jobId: shortJobId(jobId) }, 'Cannot enqueue stored scheme analysis');
      return res.status(500).json({ error: error.message || 'Не удалось запустить преобразование схемы.' });
    }
  });

  router.post('/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const streetId = String(req.body?.streetId || '');
    const buildingId = String(req.body?.buildingId || '');
    const title = cleanLabel(req.body?.title || 'Схема', 140) || 'Схема';
    if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID схемы.' });
    if (!UUID_PATTERN.test(streetId) || !UUID_PATTERN.test(buildingId))
      return res.status(400).json({ error: 'Выбери улицу и дом.' });
    try {
      const jobDir = path.join(dataDir, jobId);
      const [graphRaw, entries] = await Promise.all([
        readFile(path.join(jobDir, 'graph.json'), 'utf8'),
        readdir(jobDir),
      ]);
      const graph = JSON.parse(graphRaw);
      const sourceName = entries.find((name) => /^source\.(?:jpe?g|png|webp|tiff?)$/i.test(name));
      if (!sourceName) return res.status(404).json({ error: 'Исходное изображение этой схемы не найдено.' });
      await updateAddressLibrary((library) => {
        const context = findBuilding(library, streetId, buildingId);
        if (!context) {
          const error = new Error('Указанная улица или дом не найдены.');
          error.status = 404;
          throw error;
        }
        addSchemeToBuilding(library, context.street, context.building, {
          jobId,
          title,
          createdAt: graph.createdAt || graph.timestamp || new Date().toISOString(),
          uploadedBy: cleanLabel(req.body?.uploadedBy, 80),
          sourceName,
        });
      });
      return res.json({ ok: true, library: await readAddressLibrary() });
    } catch (error) {
      const status = error.status || (error?.code === 'ENOENT' ? 404 : 500);
      return res.status(status).json({ error: error.message || 'Не удалось добавить схему в папку дома.' });
    }
  });

  return router;
}
