import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';

/**
 * Field submission routes (P2-1): sketch report and defect photos.
 *
 * These are the two multipart endpoints; multer instances and the file store
 * are injected so upload limits stay defined in one place.
 */
export function createSubmissionRouter(ctx) {
  const {
    getWorkspace,
    getUsers,
    saveWorkspace,
    reportFilesDir,
    upload,
    defectUpload,
    persistUploadedFile,
    cleanText,
    reportForClient,
    defectReportForClient,
    onSketchSubmitted,
    log,
  } = ctx;

  const router = express.Router();

  router.post(
    '/tasks/:id/report',
    (req, res, next) => {
      if (!req.user || !['fitter', 'developer'].includes(req.user.role))
        return res.status(403).json({ error: 'Отправлять полевые отчёты может слесарь.' });
      upload.fields([{ name: 'sketch', maxCount: 1 }])(req, res, (error) => (error ? next(error) : next()));
    },
    async (req, res) => {
      const task = getWorkspace().tasks.find((item) => item.id === req.params.id);
      if (!task) {
        for (const file of Object.values(req.files || {}).flat()) await rm(file.path, { force: true }).catch(() => {});
        return res.status(404).json({ error: 'Задание не найдено.' });
      }
      if (req.user.role === 'fitter' && task.assignedTo !== req.user.id) {
        for (const file of Object.values(req.files || {}).flat()) await rm(file.path, { force: true }).catch(() => {});
        return res.status(403).json({ error: 'Нельзя отправить отчёт по чужому заданию.' });
      }
      if (task.status !== 'at_office' || !task.officeAt) {
        for (const file of Object.values(req.files || {}).flat()) await rm(file.path, { force: true }).catch(() => {});
        return res.status(409).json({ error: 'Сначала отметь завершение обхода дома и нажатие «Пришёл в офис».' });
      }
      const sketchFiles = req.files?.sketch || [];
      if (!sketchFiles.length) {
        for (const file of sketchFiles) await rm(file.path, { force: true }).catch(() => {});
        return res.status(400).json({
          error:
            'Прикрепи изображение ручного эскиза (JPG, PNG, WEBP или TIFF). Фотографии дефектов отправляются отдельно.',
        });
      }
      const reportId = randomUUID();
      const reportDir = path.join(reportFilesDir, reportId);
      await mkdir(reportDir, { recursive: true, mode: 0o700 });
      async function persistFile(file, kind) {
        const id = randomUUID();
        const ext =
          path
            .extname(path.basename(file.originalname || ''))
            .toLowerCase()
            .replace(/[^.a-z0-9]/g, '')
            .slice(0, 12) || (file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
        const fileName = `${id}${ext}`;
        await persistUploadedFile(file.path, path.join(reportDir, fileName));
        return {
          id,
          fileName,
          originalName: cleanText(path.basename(file.originalname || 'Файл'), 180),
          size: file.size,
          mimeType: file.mimetype,
          kind,
          uploadedAt: new Date().toISOString(),
        };
      }
      try {
        const sketch = await persistFile(sketchFiles[0], 'sketch');
        const author = getUsers().find((user) => user.id === req.user.id);
        const report = {
          id: reportId,
          taskId: task.id,
          taskTitle: task.title,
          street: task.street,
          address: task.address,
          userId: req.user.id,
          userName: author?.displayName || req.user.displayName,
          note: cleanText(req.body?.note, 1800),
          photos: [],
          sketch,
          status: 'processing',
          submittedAt: new Date().toISOString(),
          reviewComment: '',
          reviewedAt: null,
          seenBy: [],
          conclusionAddedAt: null,
          schemeJobId: null,
          schemeStatus: 'queued',
          schemeError: '',
          schemeCompletedAt: null,
        };
        // A re-submitted report replaces earlier versions that were explicitly
        // returned for correction. Keep their history, but do not block the
        // address folder from being transferred after the replacement is accepted.
        for (const previous of getWorkspace().reports) {
          if (previous.taskId === task.id && previous.status === 'revision_requested') {
            previous.status = 'superseded';
            previous.supersededByReportId = report.id;
          }
        }
        if (typeof onSketchSubmitted === 'function') {
          try {
            const scheme = await onSketchSubmitted({ report, sourcePath: path.join(reportDir, sketch.fileName) });
            report.schemeJobId = scheme?.jobId || null;
            report.schemeStatus = scheme?.status || 'queued';
          } catch (processingError) {
            report.schemeStatus = 'failed';
            report.schemeError = cleanText(
              processingError?.message || 'Не удалось поставить эскиз в очередь автоматической обработки.',
              900,
            );
            log.error(
              { err: processingError, reportId: report.id, taskId: task.id },
              'Failed to queue sketch for automatic processing',
            );
          }
        } else {
          report.schemeStatus = 'failed';
          report.schemeError = 'Автоматическая обработка эскиза не настроена.';
        }
        getWorkspace().reports.unshift(report);
        task.status = 'submitted';
        task.completedAt = new Date().toISOString();
        task.updatedAt = task.completedAt;
        await saveWorkspace();
        req.log.info(
          { reportId: report.id, taskId: task.id, userId: req.user.id, schemeStatus: report.schemeStatus },
          'Field sketch report submitted',
        );
        return res.status(201).json({ ok: true, report: reportForClient(report) });
      } catch (error) {
        await rm(reportDir, { recursive: true, force: true }).catch(() => {});
        for (const file of sketchFiles) await rm(file.path, { force: true }).catch(() => {});
        req.log.error({ err: error, taskId: task.id, userId: req.user.id }, 'Failed to save field sketch report');
        return res.status(500).json({ error: `Не удалось сохранить отчёт: ${error.message}` });
      }
    },
  );

  // Defect photos are a separate review queue. They do not enter CAD processing or Section 7.
  router.post(
    '/tasks/:id/defects',
    (req, res, next) => {
      if (!req.user || !['fitter', 'developer'].includes(req.user.role))
        return res.status(403).json({ error: 'Отправлять фотографии дефектов может слесарь.' });
      defectUpload.array('defectPhotos', 10)(req, res, (error) => (error ? next(error) : next()));
    },
    async (req, res) => {
      const uploaded = Array.isArray(req.files) ? req.files : [];
      const cleanupUploads = async () =>
        Promise.all(uploaded.map((file) => rm(file.path, { force: true }).catch(() => {})));
      const task = getWorkspace().tasks.find((item) => item.id === req.params.id);
      if (!task) {
        await cleanupUploads();
        return res.status(404).json({ error: 'Задание не найдено.' });
      }
      if (req.user.role === 'fitter' && task.assignedTo !== req.user.id) {
        await cleanupUploads();
        return res.status(403).json({ error: 'Нельзя отправить фотографии по чужому заданию.' });
      }
      if (!task.visitedAt || !task.officeAt) {
        await cleanupUploads();
        return res.status(409).json({ error: 'Сначала отметь, что дом пройден и ты пришёл в офис.' });
      }
      if (!uploaded.length)
        return res
          .status(400)
          .json({ error: 'Добавь хотя бы одну фотографию дефекта (JPG, PNG, WEBP, TIFF или HEIC).' });

      const reportId = randomUUID();
      const reportDir = path.join(reportFilesDir, reportId);
      let createdReport = null;
      let createdEventAt = null;
      const previousTaskUpdatedAt = task.updatedAt;
      try {
        await mkdir(reportDir, { recursive: true, mode: 0o700 });
        const photos = [];
        for (const file of uploaded) {
          const id = randomUUID();
          const ext =
            path
              .extname(path.basename(file.originalname || ''))
              .toLowerCase()
              .replace(/[^.a-z0-9]/g, '')
              .slice(0, 12) ||
            {
              'image/png': '.png',
              'image/webp': '.webp',
              'image/heic': '.heic',
              'image/heif': '.heif',
              'image/tiff': '.tiff',
              'image/x-tiff': '.tiff',
            }[file.mimetype] ||
            '.jpg';
          const fileName = `${id}${ext}`;
          await persistUploadedFile(file.path, path.join(reportDir, fileName));
          photos.push({
            id,
            fileName,
            originalName: cleanText(path.basename(file.originalname || 'Фото дефекта'), 180),
            size: file.size,
            mimeType: file.mimetype,
            uploadedAt: new Date().toISOString(),
          });
        }
        const author = getUsers().find((user) => user.id === req.user.id);
        const report = {
          id: reportId,
          taskId: task.id,
          taskTitle: task.title,
          street: task.street,
          address: task.address,
          userId: req.user.id,
          userName: author?.displayName || req.user.displayName,
          note: cleanText(req.body?.note, 1200),
          photos,
          status: 'pending_review',
          submittedAt: new Date().toISOString(),
          seenBy: [],
          reviewComment: '',
          reviewedAt: null,
          reviewedBy: null,
        };
        // A fresh photo set replaces earlier defect sets returned for correction.
        for (const previous of getWorkspace().defectReports) {
          if (previous.taskId === task.id && previous.status === 'revision_requested') {
            previous.status = 'superseded';
            previous.supersededByReportId = report.id;
          }
        }
        createdReport = report;
        getWorkspace().defectReports.unshift(report);
        task.events = Array.isArray(task.events) ? task.events : [];
        createdEventAt = report.submittedAt;
        task.events.push({
          type: 'defects_submitted',
          label: `Отправлены фотографии дефектов: ${photos.length} шт.`,
          at: createdEventAt,
          userId: req.user.id,
          userName: req.user.displayName,
        });
        task.updatedAt = report.submittedAt;
        await saveWorkspace();
        req.log.info(
          { reportId: report.id, taskId: task.id, userId: req.user.id, photos: photos.length },
          'Defect photo report submitted',
        );
        return res.status(201).json({ ok: true, report: defectReportForClient(report) });
      } catch (error) {
        if (createdReport)
          getWorkspace().defectReports = getWorkspace().defectReports.filter((item) => item.id !== createdReport.id);
        if (createdEventAt && Array.isArray(task.events)) {
          task.events = task.events.filter(
            (event) =>
              !(event.type === 'defects_submitted' && event.at === createdEventAt && event.userId === req.user.id),
          );
        }
        task.updatedAt = previousTaskUpdatedAt;
        await rm(reportDir, { recursive: true, force: true }).catch(() => {});
        await cleanupUploads();
        req.log.error(
          { err: error, taskId: task.id, userId: req.user.id, photos: uploaded.length },
          'Failed to save defect photo report',
        );
        return res.status(500).json({ error: `Не удалось сохранить фотографии дефектов: ${error.message}` });
      }
    },
  );

  // Inbox routes (routes/workforce-inbox-routes.js).
  return router;
}
