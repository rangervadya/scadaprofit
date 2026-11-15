import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { logger } from './logger.js';
import { validateBody, loginSchema, setupSchema } from './schemas.js';
import { requirePostgres } from './db.js';
import { sendJsonConditional } from './etag.js';
import { appVersion } from './version.js';
import {
  mirrorUser,
  mirrorSession,
  deleteSession,
  deleteUserSessions,
  fetchUsers,
  fetchSessions,
  findIdempotency,
  saveIdempotency,
  touchSession,
  deleteAllSessions,
} from './postgres-repo.js';
import { fetchWorkspace as fetchWorkspacePg, saveWorkspace as saveWorkspacePg } from './workforce-workspace-repo.js';
import { createUserAdminRouter } from './routes/workforce-user-routes.js';
import { createAuthRouter } from './routes/workforce-auth-routes.js';
import { createTaskRouter } from './routes/workforce-task-routes.js';
import {
  createLookupCache,
  taskForClient as taskForClientWith,
  reportForClient as reportForClientWith,
  defectReportForClient as defectReportForClientWith,
} from './workforce-serializers.js';

import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_THROTTLE_MS,
  ROLE_NAMES,
  VALID_ROLES,
  cleanText,
  splitHumanName,
  publicUser,
  tokenHash,
  validIsoDate,
  cookieValue,
  setSessionCookie,
  clearSessionCookie,
  hashPassword,
  verifyPassword,
  persistUploadedFile,
  authenticateCredentials,
  parseHouseAddresses,
  evaluateAddressFolder,
} from './workforce-core.js';

// Re-exported for existing importers (tests, server.js).
export {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_THROTTLE_MS,
  ROLE_NAMES,
  VALID_ROLES,
  cleanText,
  splitHumanName,
  publicUser,
  tokenHash,
  validIsoDate,
  cookieValue,
  setSessionCookie,
  clearSessionCookie,
  hashPassword,
  verifyPassword,
  persistUploadedFile,
  authenticateCredentials,
  parseHouseAddresses,
  evaluateAddressFolder,
};

export async function createWorkforceSystem({
  dataDir,
  uploadDir,
  secureCookies = false,
  onSketchSubmitted = null,
  getSketchStatus = null,
}) {
  const authDir = path.join(dataDir, 'workforce');
  // Legacy JSON paths are read-only: they are imported once when PostgreSQL is
  // empty and are never written again.
  const usersPath = path.join(authDir, 'users.json');
  const sessionsPath = path.join(authDir, 'sessions.json');
  const workforcePath = path.join(authDir, 'workspace.json');
  const reportFilesDir = path.join(authDir, 'report-files');
  const log = logger.child({ module: 'workforce' });
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  await mkdir(reportFilesDir, { recursive: true, mode: 0o700 });

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  requirePostgres();
  let users = await fetchUsers();
  let sessions = await fetchSessions();
  const legacyUsers = await readJson(usersPath, []);
  const knownUsers = new Set(users.map((user) => user.id));
  const missingUsers = Array.isArray(legacyUsers) ? legacyUsers.filter((user) => user && !knownUsers.has(user.id)) : [];
  if (missingUsers.length) {
    users.push(...missingUsers);
    await Promise.all(missingUsers.map((user) => mirrorUser(user)));
    log.info({ count: missingUsers.length }, 'Imported legacy users.json into PostgreSQL');
  }
  const legacySessions = await readJson(sessionsPath, []);
  const knownSessions = new Set(sessions.map((session) => session.tokenHash));
  const missingSessions = Array.isArray(legacySessions)
    ? legacySessions.filter(
        (item) =>
          item &&
          !knownSessions.has(item.tokenHash) &&
          Number(item.expiresAt) > Date.now() &&
          users.some((user) => user.id === item.userId && user.active !== false),
      )
    : [];
  if (missingSessions.length) {
    sessions.push(...missingSessions);
    await Promise.all(missingSessions.map((session) => mirrorSession(session)));
    log.info({ count: missingSessions.length }, 'Imported legacy sessions.json into PostgreSQL');
  }
  let workspace = await fetchWorkspacePg();
  if (!workspace) {
    workspace = await readJson(workforcePath, { tasks: [], reports: [] });
    const hasLegacyData =
      (Array.isArray(workspace.tasks) && workspace.tasks.length) ||
      (Array.isArray(workspace.reports) && workspace.reports.length) ||
      (Array.isArray(workspace.defectReports) && workspace.defectReports.length);
    if (hasLegacyData) {
      await saveWorkspacePg(workspace);
      log.info(
        {
          tasks: workspace.tasks.length,
          reports: workspace.reports.length,
          defects: workspace.defectReports.length,
        },
        'Imported legacy workspace.json into PostgreSQL',
      );
    }
  }
  if (!Array.isArray(users)) users = [];
  if (!Array.isArray(sessions)) sessions = [];
  if (!workspace || typeof workspace !== 'object') workspace = { tasks: [], reports: [] };
  workspace.tasks = Array.isArray(workspace.tasks) ? workspace.tasks : [];
  workspace.reports = Array.isArray(workspace.reports) ? workspace.reports : [];
  workspace.defectReports = Array.isArray(workspace.defectReports) ? workspace.defectReports : [];
  // GPS tracking was intentionally removed. Purge legacy coordinate histories from older 4.4 workspaces.
  const hadLegacyLocations = Object.prototype.hasOwnProperty.call(workspace, 'locations');
  delete workspace.locations;
  if (hadLegacyLocations) await saveWorkspacePg(workspace);

  const sessionIsLive = (item, at) => {
    if (!(Number(item.expiresAt) > at)) return false;
    // SESSION_IDLE_MS <= 0 disables the idle check (absolute TTL only).
    if (SESSION_IDLE_MS > 0 && at - Number(item.lastSeenAt || item.createdAt || 0) > SESSION_IDLE_MS) return false;
    return users.some((user) => user.id === item.userId && user.active !== false);
  };

  const now = Date.now();
  const expiredAtBoot = sessions.filter((item) => !sessionIsLive(item, now));
  sessions = sessions.filter((item) => sessionIsLive(item, now));
  if (expiredAtBoot.length) await Promise.all(expiredAtBoot.map((item) => deleteSession(item.tokenHash)));
  /**
   * Lookup indexes for the client serializers (P2-5).
   *
   * `taskForClient`, `reportForClient` and `defectReportForClient` used to scan
   * users/tasks/reports per item, so serializing a list was O(n^2). The maps are
   * built once per change and each serializer is then O(1) per entity.
   */
  // Lookup cache + serializers live in workforce-serializers.js (P2-1).
  const lookupCache = createLookupCache(users, workspace);
  // Thin wrappers keep the existing call sites (no lookups argument) unchanged.
  const taskForClient = (task) => taskForClientWith(task, lookupCache.get());
  const reportForClient = (report) => reportForClientWith(report, lookupCache.get());
  const defectReportForClient = (report) => defectReportForClientWith(report, lookupCache.get());
  const invalidateLookups = () => lookupCache.invalidate();

  const saveUsers = async () => {
    invalidateLookups();
    await Promise.all(users.map((user) => mirrorUser(user)));
  };
  const saveSessions = async () => {
    await Promise.all(sessions.map((session) => mirrorSession(session)));
  };
  const sessionCleanup = setInterval(
    () => {
      const at = Date.now();
      const expired = sessions.filter((item) => !sessionIsLive(item, at));
      const before = sessions.length;
      sessions = sessions.filter((item) => sessionIsLive(item, at));
      if (sessions.length !== before) {
        void saveSessions().catch(() => {});
        void Promise.all(expired.map((item) => deleteSession(item.tokenHash)));
      }
    },
    60 * 60 * 1000,
  );
  sessionCleanup.unref();
  let workspaceWrite = Promise.resolve();
  let lastWorkspaceSnapshot = null;
  let setupInProgress = false;
  let accountCreationInProgress = false;
  /**
   * Persist the workspace, skipping the write when nothing changed since the
   * last successful save (P2-4). Several endpoints call this on paths that do
   * not mutate data (polling, diagnostics), and every write is a transaction
   * across the normalized tables.
   */
  const saveWorkspace = () => {
    const snapshot = JSON.stringify(workspace);
    // Serialize-lookup maps are derived from the workspace; drop them so the next
    // read rebuilds against the new state (P2-5).
    invalidateLookups();
    if (snapshot === lastWorkspaceSnapshot) return Promise.resolve(true);
    const pending = workspaceWrite.then(async () => {
      const result = await saveWorkspacePg(workspace);
      lastWorkspaceSnapshot = snapshot;
      return result;
    });
    workspaceWrite = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  const multer = (await import('multer')).default;
  const isAllowedImage = (file) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    return (
      /^\.(jpe?g|png|webp|tiff?|heic|heif)$/.test(ext) || /^image\/(jpeg|png|webp|tiff|x-tiff|heic|heif)$/.test(mime)
    );
  };
  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 24 * 1024 * 1024, files: 1 },
    fileFilter(_req, file, cb) {
      if (file.fieldname === 'sketch') return cb(null, isAllowedImage(file));
      return cb(null, false);
    },
  });
  const defectUpload = multer({
    dest: uploadDir,
    limits: { fileSize: 16 * 1024 * 1024, files: 10 },
    fileFilter(_req, file, cb) {
      if (file.fieldname === 'defectPhotos') return cb(null, isAllowedImage(file));
      return cb(null, false);
    },
  });

  function getCurrentUser(req) {
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (!token) return null;
    const hash = tokenHash(token);
    const now = Date.now();
    const known = sessions.find((item) => item.tokenHash === hash);
    if (!known) return null;
    if (!sessionIsLive(known, now)) {
      // Expired or idle: drop it immediately so the row does not linger until
      // the hourly sweep.
      sessions = sessions.filter((item) => item.tokenHash !== hash);
      void deleteSession(hash).catch(() => {});
      void saveSessions().catch(() => {});
      return null;
    }
    const session = known;
    const user = users.find((item) => item.id === session.userId && item.active !== false);
    if (!user) return null;
    // Throttled activity update: at most one DB write per session per minute.
    if (now - Number(session.lastSeenAt || 0) > SESSION_TOUCH_THROTTLE_MS) {
      session.lastSeenAt = now;
      void touchSession(hash, now).catch(() => {});
    }
    return user;
  }
  function requireRoles(req, res, roles) {
    if (!req.user) {
      res.status(401).json({ error: 'Требуется войти в аккаунт.' });
      return false;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Недостаточно прав для этого действия.' });
      return false;
    }
    return true;
  }
  async function sessionForUser(res, user) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const session = {
      tokenHash: tokenHash(token),
      userId: user.id,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    sessions.push(session);
    await saveSessions();
    setSessionCookie(res, token, secureCookies);
  }
  async function authMiddleware(req, res, next) {
    const pathname = req.path;
    const authPublic = ['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/logout'];
    if (authPublic.includes(pathname) || pathname === '/api/health' || pathname === '/api/readyz') return next();

    req.user = publicUser(getCurrentUser(req));

    // Compatibility redirects for bookmarks to the previous multi-page UI.
    const legacyDestinations = {
      '/index.html': '/vdgo/',
      '/login.html': '/vdgo/login',
      '/dashboard.html': '/vdgo/',
      '/workforce.html': '/vdgo/team',
      '/conclusion.html': '/vdgo/conclusion',
      '/manual-cad.html': '/vdgo/cad',
    };
    if (legacyDestinations[pathname]) return res.redirect(308, legacyDestinations[pathname]);
    if (pathname === '/') return res.redirect(308, '/vdgo/');

    if (pathname.startsWith('/api/')) {
      if (!req.user) return res.status(401).json({ error: 'Сессия не найдена. Войди в аккаунт.', loginRequired: true });
      if (req.user.role === 'fitter' && !(pathname.startsWith('/api/workforce/') || pathname === '/api/auth/me')) {
        return res.status(403).json({
          error:
            'Слесарю доступны только личная панель, назначенные задания, отметки этапов работ и отправка ручной схемы.',
        });
      }
      if (req.user.role !== 'developer' && pathname.startsWith('/api/template') && req.method !== 'GET')
        return res.status(403).json({ error: 'Изменять глобальный шаблон может только разработчик.' });
      return next();
    }
    if (pathname.startsWith('/jobs/')) {
      if (!req.user) return res.status(401).json({ error: 'Требуется войти в аккаунт.' });
      if (req.user.role === 'fitter') return res.status(403).json({ error: 'Нет доступа к архиву обработки.' });
      return next();
    }

    const isAsset = /\.(?:css|js|mjs|png|jpe?g|webp|svg|ico|woff2?|ttf|otf|map|txt)$/i.test(pathname);
    const isSpaPath = pathname === '/vdgo' || pathname.startsWith('/vdgo/');
    if (!req.user && req.method === 'GET' && !isAsset && !isSpaPath) return res.redirect('/vdgo/login');

    // The replacement React SPA owns all user-facing pages under /vdgo/.
    // Route-level role checks live in the frontend; API permissions remain enforced above.
    if (req.user?.role === 'fitter' && req.method === 'GET' && !isAsset && !isSpaPath) {
      return res.redirect('/vdgo/team');
    }
    return next();
  }

  const routes = (await import('express')).Router();

  // Auth routes (routes/workforce-auth-routes.js).
  routes.use(
    '/api',
    createAuthRouter({
      getUsers: () => users,
      getSessions: () => sessions,
      setSessions: (next) => {
        sessions = next;
      },
      saveUsers,
      saveSessions,
      cleanText,
      hashPassword,
      publicUser,
      authenticateCredentials,
      tokenHash,
      cookieValue,
      clearSessionCookie,
      deleteSession,
      validateBody,
      setupSchema,
      loginSchema,
      SESSION_COOKIE,
      sessionForUser,
      getCurrentUser,
      isSetupInProgress: () => setupInProgress,
      setSetupInProgress: (value) => {
        setupInProgress = value;
      },
      secureCookies,
    }),
  );

  // Task routes (routes/workforce-task-routes.js).
  routes.use(
    '/api/workforce',
    createTaskRouter({
      getWorkspace: () => workspace,
      saveWorkspace,
      getUsers: () => users,
      requireRoles,
      cleanText,
      parseHouseAddresses,
      validIsoDate,
      taskForClient,
      sendJsonConditional,
      findIdempotency,
      saveIdempotency,
    }),
  );

  routes.post(
    '/api/workforce/tasks/:id/report',
    (req, res, next) => {
      if (!req.user || !['fitter', 'developer'].includes(req.user.role))
        return res.status(403).json({ error: 'Отправлять полевые отчёты может слесарь.' });
      upload.fields([{ name: 'sketch', maxCount: 1 }])(req, res, (error) => (error ? next(error) : next()));
    },
    async (req, res) => {
      const task = workspace.tasks.find((item) => item.id === req.params.id);
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
        const author = users.find((user) => user.id === req.user.id);
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
        for (const previous of workspace.reports) {
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
        workspace.reports.unshift(report);
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
  routes.post(
    '/api/workforce/tasks/:id/defects',
    (req, res, next) => {
      if (!req.user || !['fitter', 'developer'].includes(req.user.role))
        return res.status(403).json({ error: 'Отправлять фотографии дефектов может слесарь.' });
      defectUpload.array('defectPhotos', 10)(req, res, (error) => (error ? next(error) : next()));
    },
    async (req, res) => {
      const uploaded = Array.isArray(req.files) ? req.files : [];
      const cleanupUploads = async () =>
        Promise.all(uploaded.map((file) => rm(file.path, { force: true }).catch(() => {})));
      const task = workspace.tasks.find((item) => item.id === req.params.id);
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
        const author = users.find((user) => user.id === req.user.id);
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
        for (const previous of workspace.defectReports) {
          if (previous.taskId === task.id && previous.status === 'revision_requested') {
            previous.status = 'superseded';
            previous.supersededByReportId = report.id;
          }
        }
        createdReport = report;
        workspace.defectReports.unshift(report);
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
          workspace.defectReports = workspace.defectReports.filter((item) => item.id !== createdReport.id);
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

  routes.get('/api/workforce/defects', (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const list = workspace.defectReports
      .filter((report) => report.status !== 'superseded')
      .map((report) => ({
        ...defectReportForClient(report),
        seen: Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id),
      }));
    return sendJsonConditional(req, res, {
      ok: true,
      reports: list,
      unreadCount: list.filter((report) => !report.seen && report.status === 'pending_review').length,
      pendingCount: list.filter((report) => report.status === 'pending_review').length,
    });
  });

  routes.post('/api/workforce/defects/:id/seen', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = workspace.defectReports.find((item) => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Отчёт о дефектах не найден.' });
    report.seenBy = Array.isArray(report.seenBy) ? report.seenBy : [];
    if (!report.seenBy.includes(req.user.id)) report.seenBy.push(req.user.id);
    report.lastSeenAt = new Date().toISOString();
    await saveWorkspace();
    return res.json({ ok: true, seen: true });
  });

  routes.post('/api/workforce/defects/:id/review', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = workspace.defectReports.find((item) => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Отчёт о дефектах не найден.' });
    if (req.user.role === 'receiver' && !(Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id))) {
      return res.status(409).json({ error: 'Сначала открой фотографии дефектов.' });
    }
    const status = String(req.body?.status || '');
    if (!['accepted', 'revision_requested'].includes(status))
      return res.status(400).json({ error: 'Подтверди, что фотографии подходят, или верни отчёт.' });
    report.status = status;
    report.reviewComment = cleanText(req.body?.comment, 1200);
    report.reviewedAt = new Date().toISOString();
    report.reviewedBy = req.user.id;
    await saveWorkspace();
    req.log.info(
      { reportId: report.id, taskId: report.taskId, status, reviewerId: req.user.id },
      'Defect photo report reviewed',
    );
    return res.json({ ok: true, report: defectReportForClient(report) });
  });

  routes.get('/api/workforce/defects/:reportId/files/:fileId', (req, res) => {
    if (!req.user || !['fitter', 'receiver', 'supervisor', 'developer'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Нет доступа к фотографиям дефектов.' });
    }
    const report = workspace.defectReports.find((item) => item.id === req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Отчёт о дефектах не найден.' });
    if (req.user.role === 'fitter' && report.userId !== req.user.id)
      return res.status(403).json({ error: 'Нет доступа к этой фотографии.' });
    const file = (report.photos || []).find((item) => item.id === req.params.fileId);
    if (!file || !/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(file.fileName || ''))
      return res.status(404).json({ error: 'Фотография не найдена.' });
    const fullPath = path.join(reportFilesDir, report.id, file.fileName);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.originalName || 'defect-photo')}`,
    );
    return res.sendFile(fullPath, { dotfiles: 'allow' }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'Фотография дефекта недоступна.' });
    });
  });

  /**
   * Refresh a report's CAD status. Returns true when anything actually changed,
   * so callers can skip a workspace write on a poll that found nothing new.
   */
  async function refreshSchemeState(report) {
    if (!report?.schemeJobId || typeof getSketchStatus !== 'function') return false;
    const before = `${report.schemeStatus}|${report.schemeError}|${report.schemeCompletedAt}|${report.schemePartialGraphReady}|${report.status}`;
    try {
      const state = await getSketchStatus(report.schemeJobId);
      if (state?.status) report.schemeStatus = state.status;
      if (state?.error !== undefined) report.schemeError = cleanText(state.error, 900);
      if (state?.completedAt) report.schemeCompletedAt = state.completedAt;
      if (state?.partialGraphReady) report.schemePartialGraphReady = true;
      const hasReviewableResult =
        report.schemeStatus === 'completed' || (report.schemeStatus === 'failed' && report.schemePartialGraphReady);
      if (hasReviewableResult) {
        if (!['accepted', 'revision_requested'].includes(report.status)) report.status = 'pending_review';
        const task = workspace.tasks.find((item) => item.id === report.taskId);
        if (task && task.status === 'submitted') task.status = 'pending_review';
      } else if (report.schemeStatus === 'failed') {
        report.status = 'processing_failed';
        const task = workspace.tasks.find((item) => item.id === report.taskId);
        if (task && task.status === 'submitted') task.status = 'processing_failed';
      }
    } catch (error) {
      report.schemeError = cleanText(error?.message || 'Не удалось проверить состояние CAD-обработки.', 900);
      log.warn(
        { err: error, reportId: report.id, schemeJobId: report.schemeJobId },
        'Failed to refresh CAD scheme status',
      );
    }
    const after = `${report.schemeStatus}|${report.schemeError}|${report.schemeCompletedAt}|${report.schemePartialGraphReady}|${report.status}`;
    return before !== after;
  }

  routes.get('/api/workforce/reports', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    let changed = false;
    for (const report of workspace.reports) {
      if (await refreshSchemeState(report)) changed = true;
    }
    // Only persist when a scheme status actually moved: this endpoint is polled.
    if (changed) await saveWorkspace();
    const reports = workspace.reports
      .filter(
        (report) =>
          req.user.role !== 'receiver' ||
          ['processing', 'processing_failed', 'pending_review', 'accepted', 'revision_requested'].includes(
            report.status,
          ),
      )
      .map((report) => ({
        ...reportForClient(report),
        seen: Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id),
      }));
    return sendJsonConditional(req, res, {
      ok: true,
      reports,
      unreadCount: workspace.reports.filter(
        (report) =>
          report.status !== 'superseded' && (!Array.isArray(report.seenBy) || !report.seenBy.includes(req.user.id)),
      ).length,
    });
  });

  routes.post('/api/workforce/reports/:id/seen', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = workspace.reports.find((item) => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Уведомление не найдено.' });
    report.seenBy = Array.isArray(report.seenBy) ? report.seenBy : [];
    if (!report.seenBy.includes(req.user.id)) report.seenBy.push(req.user.id);
    report.lastSeenAt = new Date().toISOString();
    await saveWorkspace();
    return res.json({ ok: true, seen: true });
  });

  routes.post('/api/workforce/reports/:id/conclusion', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    return res.status(409).json({
      error:
        'Теперь схемы добавляются только целой папкой адреса. Открой уведомления по дому и нажми «Добавить папку в заключение».',
    });
  });

  routes.post('/api/workforce/defects/:id/conclusion', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    return res.status(409).json({
      error:
        'Фотографии дефектов добавляются только вместе со всей папкой адреса. Открой уведомления по дому и нажми «Добавить папку в заключение».',
    });
  });

  routes.post('/api/workforce/tasks/:taskId/conclusion', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const task = workspace.tasks.find((item) => item.id === req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Папка задания по этому адресу не найдена.' });

    const allTaskSchemes = workspace.reports.filter((report) => report.taskId === task.id);
    const allTaskDefects = workspace.defectReports.filter((report) => report.taskId === task.id);
    for (const report of allTaskSchemes) await refreshSchemeState(report);
    await saveWorkspace();
    const folderState = evaluateAddressFolder({
      schemes: allTaskSchemes,
      defects: allTaskDefects,
      userId: req.user.role === 'receiver' ? req.user.id : null,
    });
    const schemeReports = folderState.schemes;
    const defectReports = folderState.defects;
    const materialReports = folderState.items;
    if (!materialReports.length)
      return res.status(409).json({ error: 'В папке пока нет отправленных схем или фотографий дефектов.' });
    if (folderState.unseenCount)
      return res.status(409).json({ error: 'Сначала открой папку и просмотри все схемы и фотографии дефектов.' });
    if (!folderState.allAccepted) {
      const schemesPending = schemeReports.filter((report) => report.status !== 'accepted').length;
      const defectsPending = defectReports.filter((report) => report.status !== 'accepted').length;
      return res.status(409).json({
        error: `Нельзя перенести папку целиком: сначала прими все материалы. Не приняты схемы: ${schemesPending}, отчёты о дефектах: ${defectsPending}.`,
      });
    }
    if (!folderState.schemesReady)
      return res.status(409).json({
        error: 'CAD-обработка ещё не готова для одной или нескольких схем. Дождись завершения и повтори перенос папки.',
      });
    if (!folderState.photosReady)
      return res
        .status(409)
        .json({ error: 'В одном из отчётов о дефектах нет прикреплённых фотографий. Проверь папку.' });

    const addedAt = new Date().toISOString();
    const previousValues = materialReports.map((report) => ({
      report,
      conclusionAddedAt: report.conclusionAddedAt || null,
      conclusionAddedBy: report.conclusionAddedBy || null,
    }));
    const previousFolderValues = {
      conclusionFolderAddedAt: task.conclusionFolderAddedAt || null,
      conclusionFolderAddedBy: task.conclusionFolderAddedBy || null,
    };
    for (const report of materialReports) {
      report.conclusionAddedAt ||= addedAt;
      report.conclusionAddedBy ||= req.user.id;
      report.conclusionFolderId = task.id;
    }
    task.conclusionFolderAddedAt = addedAt;
    task.conclusionFolderAddedBy = req.user.id;
    try {
      await saveWorkspace();
    } catch (error) {
      for (const previous of previousValues) {
        if (previous.conclusionAddedAt) previous.report.conclusionAddedAt = previous.conclusionAddedAt;
        else delete previous.report.conclusionAddedAt;
        if (previous.conclusionAddedBy) previous.report.conclusionAddedBy = previous.conclusionAddedBy;
        else delete previous.report.conclusionAddedBy;
      }
      if (previousFolderValues.conclusionFolderAddedAt)
        task.conclusionFolderAddedAt = previousFolderValues.conclusionFolderAddedAt;
      else delete task.conclusionFolderAddedAt;
      if (previousFolderValues.conclusionFolderAddedBy)
        task.conclusionFolderAddedBy = previousFolderValues.conclusionFolderAddedBy;
      else delete task.conclusionFolderAddedBy;
      return res.status(500).json({ error: `Не удалось сохранить папку в заключение: ${error.message}` });
    }
    req.log.info(
      {
        taskId: task.id,
        userId: req.user.id,
        schemes: schemeReports.length,
        defects: defectReports.length,
        photos: defectReports.reduce((sum, report) => sum + (report.photos || []).length, 0),
      },
      'Address folder transferred into conclusion',
    );
    return res.json({
      ok: true,
      folder: {
        taskId: task.id,
        street: task.street,
        address: task.address,
        schemesCount: schemeReports.length,
        defectReportsCount: defectReports.length,
        photosCount: defectReports.reduce((sum, report) => sum + (report.photos || []).length, 0),
        addedAt,
      },
      conclusionUrl: `/conclusion.html?task=${encodeURIComponent(task.id)}`,
    });
  });

  routes.get('/api/workforce/conclusion', (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    let taskId = cleanText(req.query.task, 120);
    if (!taskId && req.query.report) {
      const target = workspace.reports.find((item) => item.id === String(req.query.report));
      if (target?.conclusionAddedAt && target.status === 'accepted') taskId = target.taskId;
    }
    if (!taskId && req.query.defectReport) {
      const target = workspace.defectReports.find((item) => item.id === String(req.query.defectReport));
      if (target?.conclusionAddedAt && target.status === 'accepted') taskId = target.taskId;
    }
    if (!taskId) return res.json({ ok: true, task: null, reports: [], defectReports: [] });
    const task = workspace.tasks.find((item) => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задание или адрес для заключения не найден.' });
    const reports = workspace.reports
      .filter((report) => report.taskId === taskId && Boolean(report.conclusionAddedAt) && report.status === 'accepted')
      .map((report) => {
        const manualCadBase = report.manualCadProjectId
          ? `/api/manual-cad/projects/${encodeURIComponent(report.manualCadProjectId)}`
          : null;
        return {
          ...reportForClient(report),
          schemeSvgUrl: manualCadBase
            ? `${manualCadBase}/preview.svg`
            : report.schemeJobId
              ? `/jobs/${report.schemeJobId}/clean.svg`
              : null,
          schemeDxfUrl: manualCadBase
            ? `${manualCadBase}/export.dxf`
            : report.schemeJobId
              ? `/jobs/${report.schemeJobId}/drawing.dxf`
              : null,
          schemeOriginalUrl: report.sketch
            ? `/api/workforce/reports/${encodeURIComponent(report.id)}/files/${encodeURIComponent(report.sketch.id)}`
            : null,
        };
      });
    const defectReports = workspace.defectReports
      .filter((report) => report.taskId === taskId && Boolean(report.conclusionAddedAt) && report.status === 'accepted')
      .map(defectReportForClient);
    return res.json({
      ok: true,
      task: {
        id: task.id,
        title: task.title,
        street: task.street,
        address: task.address,
        scheduledDate: task.scheduledDate,
      },
      reports,
      defectReports,
    });
  });

  routes.post('/api/workforce/reports/:id/review', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = workspace.reports.find((item) => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Отчёт не найден.' });
    if (req.user.role === 'receiver' && !(Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id))) {
      return res.status(409).json({ error: 'Сначала открой папку адреса и просмотри эту схему.' });
    }
    const status = String(req.body?.status || '');
    if (!['accepted', 'revision_requested'].includes(status))
      return res.status(400).json({ error: 'Выбери приёмку или возврат на исправление.' });
    report.status = status;
    report.reviewComment = cleanText(req.body?.comment, 1200);
    report.reviewedAt = new Date().toISOString();
    const task = workspace.tasks.find((item) => item.id === report.taskId);
    if (task) {
      task.status = status;
      task.updatedAt = report.reviewedAt;
      if (status === 'revision_requested') {
        task.completedAt = null;
        task.visitedAt = null;
        task.officeAt = null;
      }
    }
    await saveWorkspace();
    req.log.info(
      { reportId: report.id, taskId: report.taskId, status, reviewerId: req.user.id },
      'Sketch report reviewed',
    );
    return res.json({ ok: true, report: reportForClient(report), task: task ? taskForClient(task) : null });
  });

  routes.get('/api/workforce/reports/:reportId/files/:fileId', async (req, res) => {
    const report = workspace.reports.find((item) => item.id === req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Отчёт не найден.' });
    if (req.user.role === 'fitter' && report.userId !== req.user.id)
      return res.status(403).json({ error: 'Нет доступа к этому файлу.' });
    const file = [...(report.photos || []), ...(report.sketch ? [report.sketch] : [])].find(
      (item) => item.id === req.params.fileId,
    );
    if (!file || !/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(file.fileName))
      return res.status(404).json({ error: 'Файл не найден.' });
    const fullPath = path.join(reportFilesDir, report.id, file.fileName);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.originalName || 'report-file')}`,
    );
    return res.sendFile(fullPath, { dotfiles: 'allow' }, (error) => {
      if (error) req.log.warn({ err: error, fullPath }, 'Cannot send workforce report file');
      if (error && !res.headersSent) res.status(404).json({ error: 'Файл отчёта недоступен.' });
    });
  });

  routes.get('/api/workforce/overview', (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const visibleUsers = users.filter(
      (user) =>
        user.active !== false &&
        (req.user.role === 'receiver' ? ['fitter', 'supervisor'].includes(user.role) : user.role !== 'developer'),
    );
    const userList = visibleUsers.map((user) => ({
      ...publicUser(user),
      assignedTasks: workspace.tasks.filter(
        (task) => task.assignedTo === user.id && !['accepted'].includes(task.status),
      ).length,
      activeTask: workspace.tasks.find(
        (task) => task.assignedTo === user.id && !['accepted', 'submitted'].includes(task.status),
      )
        ? taskForClient(
            workspace.tasks.find(
              (task) => task.assignedTo === user.id && !['accepted', 'submitted'].includes(task.status),
            ),
          )
        : null,
    }));
    return sendJsonConditional(req, res, {
      ok: true,
      users: userList,
      tasks: workspace.tasks.map(taskForClient),
      reports: workspace.reports.map(reportForClient),
      defectReports: workspace.defectReports.map(defectReportForClient),
      summary: {
        activeFitters: users.filter((user) => user.active !== false && user.role === 'fitter').length,
        assigned: workspace.tasks.filter((task) => ['assigned', 'in_progress'].includes(task.status)).length,
        submitted: workspace.tasks.filter((task) => task.status === 'submitted').length,
        pendingReports: workspace.reports.filter((report) => report.status === 'pending_review').length,
        pendingDefects: workspace.defectReports.filter((report) => report.status === 'pending_review').length,
      },
    });
  });

  function makeLogin(displayName) {
    const transliteration = {
      а: 'a',
      б: 'b',
      в: 'v',
      г: 'g',
      д: 'd',
      е: 'e',
      ё: 'e',
      ж: 'zh',
      з: 'z',
      и: 'i',
      й: 'y',
      к: 'k',
      л: 'l',
      м: 'm',
      н: 'n',
      о: 'o',
      п: 'p',
      р: 'r',
      с: 's',
      т: 't',
      у: 'u',
      ф: 'f',
      х: 'h',
      ц: 'ts',
      ч: 'ch',
      ш: 'sh',
      щ: 'shch',
      ъ: '',
      ы: 'y',
      ь: '',
      э: 'e',
      ю: 'yu',
      я: 'ya',
    };
    const base =
      String(displayName || '')
        .toLowerCase()
        .split('')
        .map((char) => transliteration[char] ?? char)
        .join('')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.|\.$/g, '')
        .slice(0, 34) || 'employee';
    let candidate = base;
    let suffix = 2;
    while (users.some((user) => user.username.toLowerCase() === candidate.toLowerCase()))
      candidate = `${base.slice(0, 42)}.${suffix++}`;
    return candidate;
  }

  // User administration routes (routes/workforce-user-routes.js).
  routes.use(
    '/api/workforce',
    createUserAdminRouter({
      getUsers: () => users,
      getSessions: () => sessions,
      setSessions: (next) => {
        sessions = next;
      },
      getWorkspace: () => workspace,
      saveUsers,
      saveSessions,
      requireRoles,
      publicUser,
      hashPassword,
      cleanText,
      splitHumanName,
      VALID_ROLES,
      sendJsonConditional,
      deleteSession,
      deleteUserSessions,
      deleteAllSessions,
      appVersion,
      makeLogin,
      isAccountCreationInProgress: () => accountCreationInProgress,
      setAccountCreationInProgress: (value) => {
        accountCreationInProgress = value;
      },
    }),
  );

  async function linkManualCadProject(reportId, projectId) {
    const report = workspace.reports.find((item) => item.id === reportId);
    if (!report || !projectId) return false;
    report.manualCadProjectId = String(projectId);
    await saveWorkspace();
    return true;
  }

  function getReport(reportId) {
    return workspace.reports.find((report) => report.id === reportId) || null;
  }
  function getReportFilePath(reportId, fileId) {
    const report = getReport(reportId);
    if (!report) return null;
    const file = [...(report.photos || []), ...(report.sketch ? [report.sketch] : [])].find(
      (item) => item.id === fileId,
    );
    if (!file || !/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(file.fileName || '')) return null;
    return path.join(reportFilesDir, report.id, file.fileName);
  }
  return { authMiddleware, router: routes, roleNames: ROLE_NAMES, getReport, getReportFilePath, linkManualCadProject };
}
