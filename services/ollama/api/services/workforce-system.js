import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { logger } from '../lib/logger.js';
import { validateBody, loginSchema, setupSchema } from '../validation/schemas.js';
import { requirePostgres } from '../repositories/db.js';
import { sendJsonConditional } from '../lib/etag.js';
import { appVersion } from '../lib/version.js';
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
} from '../repositories/postgres-repo.js';
import {
  fetchWorkspace as fetchWorkspacePg,
  saveWorkspace as saveWorkspacePg,
} from '../repositories/workforce-workspace-repo.js';
import { createUserAdminRouter } from '../routes/workforce-user-routes.js';
import { createAuthRouter } from '../routes/workforce-auth-routes.js';
import { createTaskRouter } from '../routes/workforce-task-routes.js';
import { createInboxRouter } from '../routes/workforce-inbox-routes.js';
import { createSubmissionRouter } from '../routes/workforce-submission-routes.js';
import {
  createLookupCache,
  taskForClient as taskForClientWith,
  reportForClient as reportForClientWith,
  defectReportForClient as defectReportForClientWith,
} from '../domain/workforce-serializers.js';

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
} from '../domain/workforce-core.js';

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

  // Inbox routes (routes/workforce-inbox-routes.js).
  routes.use(
    '/api/workforce',
    createInboxRouter({
      getWorkspace: () => workspace,
      getUsers: () => users,
      saveWorkspace,
      requireRoles,
      cleanText,
      reportForClient,
      defectReportForClient,
      sendJsonConditional,
      getSketchStatus,
      evaluateAddressFolder,
      reportFilesDir,
      log,
      taskForClient,
      publicUser,
    }),
  );

  // Field submission routes (routes/workforce-submission-routes.js).
  routes.use(
    '/api/workforce',
    createSubmissionRouter({
      getWorkspace: () => workspace,
      getUsers: () => users,
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
    }),
  );

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
