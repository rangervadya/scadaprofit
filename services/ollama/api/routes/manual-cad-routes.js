import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

/**
 * Manual CAD routes (P2-1): import from jobs/reports, project CRUD, exports.
 *
 * The geometry helpers and persistence functions are injected so this module
 * stays a pure HTTP layer.
 */
export function createManualCadRouter({
  dataDir,
  manualCadDir,
  readSchemeMeta,
  workforceSystem,
  manualSourceUpload,
  rasterDimensions,
  readManualProject,
  writeManualProject,
  writeManualProjectIfRevision,
  listManualProjects,
  findManualCadProjectForJob,
  findManualCadProjectForReport,
  findScheme,
  readAddressLibrary,
  createManualCadProject,
  createManualCadProjectFromGraph,
  normalizeManualCadProject,
  renderManualCadSvg,
  renderManualCadDxf,
  isManualCadId,
  manualProjectPath,
  manualProjectResponse,
  cleanLabel,
  sendJsonConditional,
  validateBody,
  manualProjectCreateSchema,
  limitHeavyRequests,
  heavyQuota,
  shortJobId,
  JOB_ID_PATTERN,
}) {
  const router = express.Router();

  router.post('/import-job/:jobId', limitHeavyRequests, heavyQuota, async (req, res) => {
    const { jobId } = req.params;
    if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID задания.' });
    let projectDir = null;
    try {
      const [rawGraph, preparedImage, library] = await Promise.all([
        readFile(path.join(dataDir, jobId, 'graph.json'), 'utf8'),
        // The prepared image is in the exact coordinate space of graph.image.
        // Do not fall back to the unrotated upload: that would misalign geometry.
        readFile(path.join(dataDir, jobId, 'prepared-input.png')),
        readAddressLibrary(),
      ]);
      const graph = JSON.parse(rawGraph);
      if (!graph?.image?.width || !graph?.image?.height) {
        return res.status(409).json({
          error: 'В графе нет размеров подготовленного изображения. Повторно обработай схему перед переносом в CAD.',
        });
      }
      const address = findScheme(library, jobId);
      if (!address) return res.status(404).json({ error: 'Схема больше не привязана к папке улицы и дома.' });
      const schemeMeta = await readSchemeMeta(jobId);
      const title = cleanLabel(req.body?.title || schemeMeta?.title || address.scheme.title || 'Чертёж дома', 140);
      const siteAddress = `${address.street.name}, дом ${address.building.name}`;
      const workforceReportId = schemeMeta?.workforceReportId || null;
      const existing = await findManualCadProjectForJob(jobId);

      // Re-open the same CAD project for this house scheme. If nobody has edited
      // it yet, a retry of an incomplete Qwen job may refresh the imported draft.
      // Once a user edits the CAD project, never overwrite those manual changes.
      if (existing) {
        if (workforceReportId && existing.sourceReportId !== workforceReportId) {
          existing.sourceReportId = workforceReportId;
          await writeManualProject(existing);
        }
        if (existing.sourceReportId) await workforceSystem.linkManualCadProject(existing.sourceReportId, existing.id);
        if (Number(existing.manualEditRevision || 0) === 0) {
          const refreshed = createManualCadProjectFromGraph(graph, {
            id: existing.id,
            title,
            siteAddress,
            sourceJobId: jobId,
            sourceStreetId: address.street.id,
            sourceBuildingId: address.building.id,
          });
          refreshed.createdAt = existing.createdAt || refreshed.createdAt;
          refreshed.source = {
            fileName: 'source.png',
            originalName: 'Подготовленное изображение автообработки',
            size: preparedImage.length,
            uploadedAt: new Date().toISOString(),
          };
          refreshed.manualEditRevision = 0;
          refreshed.sourceReportId = workforceReportId || existing.sourceReportId || null;
          projectDir = path.join(manualCadDir, existing.id);
          await writeFile(path.join(projectDir, 'source.png'), preparedImage);
          await writeManualProject(refreshed);
          if (refreshed.sourceReportId)
            await workforceSystem.linkManualCadProject(refreshed.sourceReportId, refreshed.id);
          req.log.info(
            { jobId: shortJobId(jobId), projectId: existing.id.slice(0, 8) },
            'Refreshed unedited house project from job',
          );
          return res.json({ ok: true, reused: true, refreshed: true, project: manualProjectResponse(refreshed) });
        }
        return res.json({
          ok: true,
          reused: true,
          preservedManualEdits: true,
          project: manualProjectResponse(existing),
        });
      }

      const projectId = randomUUID();
      projectDir = path.join(manualCadDir, projectId);
      const project = createManualCadProjectFromGraph(graph, {
        id: projectId,
        title,
        siteAddress,
        sourceJobId: jobId,
        sourceStreetId: address.street.id,
        sourceBuildingId: address.building.id,
      });
      project.sourceReportId = workforceReportId;
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, 'source.png'), preparedImage);
      project.source = {
        fileName: 'source.png',
        originalName: 'Подготовленное изображение автообработки',
        size: preparedImage.length,
        uploadedAt: new Date().toISOString(),
      };
      await writeManualProject(project);
      if (project.sourceReportId) await workforceSystem.linkManualCadProject(project.sourceReportId, project.id);
      req.log.info(
        {
          jobId: shortJobId(jobId),
          projectId: projectId.slice(0, 8),
          pipes: project.pipes.length,
          labels: project.labels.length,
          symbols: project.symbols.length,
        },
        'Created house project',
      );
      return res.status(201).json({ ok: true, reused: false, project: manualProjectResponse(project) });
    } catch (error) {
      if (
        projectDir &&
        !(await readManualProject(path.basename(projectDir))
          .then(() => true)
          .catch(() => false))
      ) {
        await rm(projectDir, { recursive: true, force: true }).catch(() => {});
      }
      const status = error?.code === 'ENOENT' ? 404 : 400;
      return res.status(status).json({
        error:
          status === 404
            ? 'Подготовленное изображение, граф задания или папка дома не найдены. Повтори обработку схемы и попробуй снова.'
            : error.message || 'Не удалось подготовить чистовой CAD-лист.',
      });
    }
  });

  // Source-only CAD fallback: a stored house photo can still be traced manually
  // even when OCR/Qwen failed before graph.json or prepared-input.png was written.
  // This route touches only the primary app's DATA/.private/manual-cad directory.
  router.post('/import-source-job/:jobId', limitHeavyRequests, heavyQuota, async (req, res) => {
    const { jobId } = req.params;
    if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID задания.' });
    let projectDir = null;
    try {
      const library = await readAddressLibrary();
      const address = findScheme(library, jobId);
      if (!address) return res.status(404).json({ error: 'Схема больше не привязана к папке улицы и дома.' });
      const existing = await findManualCadProjectForJob(jobId);
      if (existing) return res.json({ ok: true, reused: true, project: manualProjectResponse(existing) });

      const meta = await readSchemeMeta(jobId);
      if (!meta?.sourceName) return res.status(404).json({ error: 'Исходная фотография не найдена.' });
      const sourceName = path.basename(String(meta.sourceName));
      if (!/^source\.(?:jpe?g|png|webp|tiff?)$/i.test(sourceName)) {
        return res.status(400).json({ error: 'Недопустимое имя исходного файла.' });
      }
      const sourcePath = path.join(dataDir, jobId, sourceName);
      const sourceBytes = await readFile(sourcePath);
      const extension = path.extname(sourceName).toLowerCase();
      const width = Math.round(Math.max(100, Math.min(30000, Number(req.body?.width) || 1600)));
      const height = Math.round(Math.max(100, Math.min(30000, Number(req.body?.height) || 1000)));
      const projectId = randomUUID();
      projectDir = path.join(manualCadDir, projectId);
      const project = createManualCadProject({
        id: projectId,
        title: cleanLabel(req.body?.title || meta.title || address.scheme.title || 'Чертёж дома', 140),
      });
      project.width = width;
      project.height = height;
      project.page = width > height ? 'landscape' : 'portrait';
      project.paperSize = 'A4';
      project.drawingStyle = 'lpgcad-r1';
      project.siteAddress = `${address.street.name}, дом ${address.building.name}`;
      project.sourceJobId = jobId;
      project.sourceStreetId = address.street.id;
      project.sourceBuildingId = address.building.id;
      project.analysisComplete = false;
      project.notes =
        'Ручная трассировка по исходной фотографии: автоматическая геометрия не была доступна. Начертите фактические трубопроводы, ответвления и оборудование по подложке; не используйте предположительные размеры или соединения.';
      project.source = {
        fileName: `source${extension}`,
        originalName: cleanLabel(meta.originalName || sourceName, 180),
        size: sourceBytes.length,
        uploadedAt: new Date().toISOString(),
      };
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, project.source.fileName), sourceBytes);
      await writeManualProject(project);
      req.log.info(
        { jobId: shortJobId(projectId), projectId: projectId.slice(0, 8) },
        'Created source-only manual project for failed or unavailable job',
      );
      return res
        .status(201)
        .json({ ok: true, reused: false, sourceOnly: true, project: manualProjectResponse(project) });
    } catch (error) {
      if (
        projectDir &&
        !(await readManualProject(path.basename(projectDir))
          .then(() => true)
          .catch(() => false))
      ) {
        await rm(projectDir, { recursive: true, force: true }).catch(() => {});
      }
      const status = error?.code === 'ENOENT' ? 404 : 400;
      return res.status(status).json({
        error:
          status === 404
            ? 'Исходная фотография не найдена. Повтори загрузку схемы.'
            : error.message || 'Не удалось создать CAD-проект по исходной фотографии.',
      });
    }
  });

  router.post('/import-workforce-report/:reportId', async (req, res) => {
    if (!['receiver', 'supervisor', 'developer'].includes(req.user?.role)) {
      return res.status(403).json({ error: 'Открывать отчёты в CAD может приёмщик, руководитель или разработчик.' });
    }
    const report = workforceSystem.getReport(req.params.reportId);
    if (!report?.sketch) return res.status(404).json({ error: 'В отчёте не найдена ручная схема.' });
    const ext = path.extname(String(report.sketch.originalName || '')).toLowerCase();
    const allowed = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);
    if (!allowed.has(ext) || !String(report.sketch.mimeType || '').startsWith('image/')) {
      return res.status(415).json({
        error:
          'Для прямого открытия в CAD загрузи ручную схему как JPG, PNG, WEBP или TIFF. PDF можно открыть отдельно.',
      });
    }
    let projectDir = null;
    try {
      const existing = await findManualCadProjectForReport(report.id);
      if (existing) return res.json({ ok: true, reused: true, project: manualProjectResponse(existing) });
      const sourcePath = workforceSystem.getReportFilePath(report.id, report.sketch.id);
      if (!sourcePath) return res.status(404).json({ error: 'Файл ручной схемы не найден в хранилище отчётов.' });
      const sourceBytes = await readFile(sourcePath);
      const id = randomUUID();
      projectDir = path.join(manualCadDir, id);
      const project = createManualCadProject({
        id,
        title: cleanLabel(`${report.street}, дом ${report.address} — ${report.taskTitle}`, 140),
      });
      const dimensions = rasterDimensions(sourceBytes);
      project.width = Math.max(100, Math.min(30000, dimensions.width));
      project.height = Math.max(100, Math.min(30000, dimensions.height));
      project.siteAddress = `${report.street}, дом ${report.address}`;
      project.preparedBy = cleanLabel(report.userName || '', 100);
      project.notes = `Исходный ручной эскиз из отчёта ${report.id}. Перед чистовым выпуском проверь фактические трассы, соединения, размеры и оборудование.`;
      project.sourceReportId = report.id;
      project.source = {
        fileName: `source${ext}`,
        originalName: cleanLabel(report.sketch.originalName, 180),
        size: sourceBytes.length,
        uploadedAt: report.sketch.uploadedAt || report.submittedAt || new Date().toISOString(),
      };
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, project.source.fileName), sourceBytes);
      await writeManualProject(project);
      return res.status(201).json({ ok: true, reused: false, project: manualProjectResponse(project) });
    } catch (error) {
      if (projectDir) await rm(projectDir, { recursive: true, force: true }).catch(() => {});
      req.log.error(
        {
          err: error,
          projectId: projectDir ? path.basename(projectDir).slice(0, 8) : null,
          reportId: req.params.reportId,
        },
        'Cannot create manual project from job',
      );
      return res.status(500).json({ error: error.message || 'Не удалось открыть ручной эскиз в CAD.' });
    }
  });

  router.get('/projects', async (req, res) => {
    try {
      const projects = (await listManualProjects())
        .map((project) => ({
          id: project.id,
          title: project.title,
          updatedAt: project.updatedAt,
          createdAt: project.createdAt,
          source: project.source || null,
          sourceJobId: project.sourceJobId || null,
          siteAddress: project.siteAddress || '',
          pipeCount: Array.isArray(project.pipes) ? project.pipes.filter((pipe) => pipe.reviewOnly !== true).length : 0,
        }))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      return sendJsonConditional(req, res, { ok: true, projects });
    } catch (error) {
      req.log.error({ err: error }, 'Cannot list manual CAD projects');
      return res.status(500).json({ error: error.message || 'Не удалось получить список ручных чертежей.' });
    }
  });

  router.post('/projects', validateBody(manualProjectCreateSchema), async (req, res) => {
    const id = randomUUID();
    const projectDir = path.join(manualCadDir, id);
    try {
      await mkdir(projectDir, { recursive: true });
      const project = createManualCadProject({ id, title: cleanLabel(req.body?.title || 'Новая схема', 140) });
      await writeManualProject(project);
      return res.status(201).json({ ok: true, project: manualProjectResponse(project) });
    } catch (error) {
      await rm(projectDir, { recursive: true, force: true }).catch(() => {});
      req.log.error({ err: error }, 'Cannot create manual CAD project');
      return res.status(500).json({ error: error.message || 'Не удалось создать ручной чертёж.' });
    }
  });

  router.get('/projects/:id', async (req, res) => {
    const { id } = req.params;
    if (!isManualCadId(id)) return res.status(400).json({ error: 'Некорректный ID проекта.' });
    try {
      const project = await readManualProject(id);
      return res.json({ ok: true, project: manualProjectResponse(project) });
    } catch (error) {
      return res.status(error?.code === 'ENOENT' ? 404 : 500).json({ error: 'Не удалось открыть ручной чертёж.' });
    }
  });

  router.put('/projects/:id', async (req, res) => {
    const { id } = req.params;
    if (!isManualCadId(id)) return res.status(400).json({ error: 'Некорректный ID проекта.' });
    try {
      const current = await readManualProject(id);
      const input = req.body?.project && typeof req.body.project === 'object' ? req.body.project : req.body;
      const project = normalizeManualCadProject(input, current);
      project.source = current.source || null;
      const currentRevision = Math.max(0, Number(current.manualEditRevision || 0));
      project.manualEditRevision = currentRevision + 1;

      // Optimistic concurrency: reject a write built on a stale revision.
      // Clients may send If-Match: "<rev>" or body.expectedRevision.
      const ifMatch = String(req.get('If-Match') || '')
        .replace(/"/g, '')
        .trim();
      const expectedRevision = ifMatch !== '' ? Number(ifMatch) : Number(req.body?.expectedRevision);
      if (Number.isFinite(expectedRevision) && expectedRevision !== currentRevision) {
        return res.status(409).json({
          error: 'Чертёж был изменён другим редактором. Обновите страницу и повторите сохранение.',
          code: 'REVISION_CONFLICT',
          currentRevision,
        });
      }

      const result = await writeManualProjectIfRevision(project, currentRevision);
      if (result === 'conflict') {
        return res.status(409).json({
          error: 'Чертёж был изменён другим редактором. Обновите страницу и повторите сохранение.',
          code: 'REVISION_CONFLICT',
          currentRevision,
        });
      }
      if (result === 'missing') return res.status(404).json({ error: 'Чертёж не найден.' });

      res.set('ETag', `"${project.manualEditRevision}"`);
      return res.json({ ok: true, project: manualProjectResponse(project) });
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 400;
      return res.status(status).json({ error: error.message || 'Не удалось сохранить ручной чертёж.' });
    }
  });

  router.post(
    '/api/manual-cad/projects/:id/source',
    limitHeavyRequests,
    manualSourceUpload.single('source'),
    async (req, res) => {
      const { id } = req.params;
      if (!isManualCadId(id)) {
        if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
        return res.status(400).json({ error: 'Некорректный ID проекта.' });
      }
      if (!req.file) return res.status(400).json({ error: 'Выбери JPG, PNG, WEBP или TIFF.' });
      try {
        const project = await readManualProject(id);
        const ext = path.extname(String(req.file.originalname || '')).toLowerCase();
        const allowed = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);
        if (!allowed.has(ext)) throw new Error('Неподдерживаемый формат изображения.');
        const fileName = `source${ext}`;
        const projectDir = path.dirname(manualProjectPath(id));
        await mkdir(projectDir, { recursive: true });
        await rename(req.file.path, path.join(projectDir, fileName));
        const width = Math.round(Math.max(100, Math.min(30000, Number(req.body?.width) || project.width || 1600)));
        const height = Math.round(Math.max(100, Math.min(30000, Number(req.body?.height) || project.height || 1000)));
        project.source = {
          fileName,
          originalName: cleanLabel(req.file.originalname, 180),
          size: req.file.size,
          uploadedAt: new Date().toISOString(),
        };
        project.width = width;
        project.height = height;
        project.updatedAt = new Date().toISOString();
        await writeManualProject(project);
        return res.json({ ok: true, project: manualProjectResponse(project) });
      } catch (error) {
        if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
        const status = error?.code === 'ENOENT' ? 404 : 400;
        return res.status(status).json({ error: error.message || 'Не удалось загрузить исходный эскиз.' });
      }
    },
  );

  router.get('/projects/:id/source', async (req, res) => {
    const { id } = req.params;
    if (!isManualCadId(id)) return res.status(400).end();
    try {
      const project = await readManualProject(id);
      const fileName = path.basename(String(project.source?.fileName || ''));
      if (!fileName || !/^source\.(jpe?g|png|webp|tiff?)$/i.test(fileName))
        return res.status(404).json({ error: 'Подложка не загружена.' });
      return res.sendFile(path.join(path.dirname(manualProjectPath(id)), fileName));
    } catch (error) {
      return res.status(error?.code === 'ENOENT' ? 404 : 500).json({ error: 'Не удалось открыть подложку.' });
    }
  });

  router.get('/projects/:id/preview.svg', async (req, res) => {
    const { id } = req.params;
    if (!isManualCadId(id)) return res.status(400).end();
    try {
      const project = await readManualProject(id);
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(renderManualCadSvg(project, { includeReview: req.query.draft === '1' }));
    } catch (error) {
      return res
        .status(error?.code === 'ENOENT' ? 404 : 500)
        .json({ error: 'Не удалось сформировать предпросмотр CAD.' });
    }
  });

  router.get('/projects/:id/export.svg', async (req, res) => {
    const { id } = req.params;
    if (!isManualCadId(id)) return res.status(400).end();
    try {
      const project = await readManualProject(id);
      const svg = renderManualCadSvg(project);
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="manual-cad-${id.slice(0, 8)}.svg"`);
      return res.send(svg);
    } catch (error) {
      return res.status(error?.code === 'ENOENT' ? 404 : 500).json({ error: 'Не удалось сформировать SVG.' });
    }
  });

  router.get('/projects/:id/export.dxf', async (req, res) => {
    const { id } = req.params;
    if (!isManualCadId(id)) return res.status(400).end();
    try {
      const project = await readManualProject(id);
      const dxf = renderManualCadDxf(project);
      res.setHeader('Content-Type', 'application/dxf; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="manual-cad-${id.slice(0, 8)}.dxf"`);
      return res.send(dxf);
    } catch (error) {
      return res.status(error?.code === 'ENOENT' ? 404 : 500).json({ error: 'Не удалось сформировать DXF.' });
    }
  });

  return router;
}
