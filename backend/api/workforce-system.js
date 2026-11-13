import path from 'node:path';
import { randomUUID, randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, chmod, rename, rm } from 'node:fs/promises';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'profit_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROLE_NAMES = {
  fitter: 'Слесарь',
  receiver: 'Приёмщик',
  supervisor: 'Руководитель',
  developer: 'Разработчик'
};
const VALID_ROLES = new Set(Object.keys(ROLE_NAMES));

function cleanText(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function splitHumanName(value) {
  const parts = cleanText(value, 100).split(' ').filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}
function publicUser(user) {
  if (!user) return null;
  const parsedName = splitHumanName(user.displayName);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    firstName: user.firstName || parsedName.firstName,
    lastName: user.lastName || parsedName.lastName,
    role: user.role,
    roleName: ROLE_NAMES[user.role] || user.role,
    active: user.active !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt || null
  };
}
function tokenHash(token) { return createHash('sha256').update(String(token)).digest('hex'); }
function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function parseHouseAddresses(value, fallbackAddress = '') {
  let candidates = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : String(value).split(/[\r\n;]+/);
  if (!candidates.some(item => String(item ?? '').trim()) && fallbackAddress) candidates = [fallbackAddress];

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const address = cleanText(candidate, 120);
    if (!address) continue;
    const key = address.toLocaleLowerCase('ru-RU');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(address);
    if (unique.length > 100) throw new RangeError('За одно назначение можно добавить не более 100 домов.');
  }
  return unique;
}

/** Evaluate whether every live item in one address folder is ready for a single conclusion transfer. */
export function evaluateAddressFolder({ schemes = [], defects = [], userId = null } = {}) {
  const liveSchemes = (Array.isArray(schemes) ? schemes : []).filter(item => item?.status !== 'superseded');
  const liveDefects = (Array.isArray(defects) ? defects : []).filter(item => item?.status !== 'superseded');
  const items = [...liveSchemes, ...liveDefects];
  const allAccepted = items.length > 0 && items.every(item => item.status === 'accepted');
  const schemesReady = liveSchemes.every(item => item.schemeJobId && (
    item.schemeStatus === 'completed' || (item.schemeStatus === 'failed' && item.schemePartialGraphReady === true)
  ));
  const photosReady = liveDefects.every(item => Array.isArray(item.photos) && item.photos.length > 0);
  const unseenCount = userId
    ? items.filter(item => !(Array.isArray(item.seenBy) && item.seenBy.includes(userId))).length
    : 0;
  return {
    items, schemes: liveSchemes, defects: liveDefects,
    allAccepted, schemesReady, photosReady, unseenCount,
    ready: allAccepted && schemesReady && photosReady && unseenCount === 0
  };
}
function cookieValue(header, name) {
  const prefix = `${name}=`;
  for (const part of String(header || '').split(';')) {
    const item = part.trim();
    if (item.startsWith(prefix)) { try { return decodeURIComponent(item.slice(prefix.length)); } catch { return ''; } }
  }
  return '';
}
function setSessionCookie(res, token, secure) {
  const flags = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}
function clearSessionCookie(res, secure) {
  const flags = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(String(password), salt, 64);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !/^[a-f0-9]{128}$/i.test(expectedHex || '')) return false;
  const actual = Buffer.from(await scrypt(String(password), salt, 64));
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Persist a Multer temporary upload in the private data directory. Multer's
 * default temp directory may be mounted on a different filesystem from the
 * persistent /data volume, so renaming the upload directly can fail with
 * EXDEV. Copy to a unique staging file beside the destination, then rename
 * within that filesystem (atomic there). The source is removed only after
 * the destination has been committed.
 */
export async function persistUploadedFile(sourcePath, destinationPath) {
  const destinationDir = path.dirname(destinationPath);
  const stagingPath = path.join(
    destinationDir,
    `.${path.basename(destinationPath)}.${randomUUID()}.uploading`
  );
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  try {
    await copyFile(sourcePath, stagingPath);
    await chmod(stagingPath, 0o600);
    // Both paths are on the destination filesystem, avoiding cross-device rename.
    await rename(stagingPath, destinationPath);
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => {});
    throw error;
  }
  // A cleanup failure must not turn a successfully saved report into an error.
  await rm(sourcePath, { force: true }).catch(() => {});
  return destinationPath;
}

// The same credential check is used by the login endpoint and tested directly.
export async function authenticateCredentials(users, username, password) {
  const normalizedUsername = cleanText(username, 48).toLowerCase();
  const user = (Array.isArray(users) ? users : []).find(item =>
    String(item?.username || '').toLowerCase() === normalizedUsername && item.active !== false
  );
  if (!user || !await verifyPassword(String(password || ''), user.passwordHash)) return null;
  return user;
}

export async function createWorkforceSystem({ dataDir, uploadDir, secureCookies = false, onSketchSubmitted = null, getSketchStatus = null }) {
  const authDir = path.join(dataDir, 'workforce');
  const usersPath = path.join(authDir, 'users.json');
  const sessionsPath = path.join(authDir, 'sessions.json');
  const workforcePath = path.join(authDir, 'workspace.json');
  const reportFilesDir = path.join(authDir, 'report-files');
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  await mkdir(reportFilesDir, { recursive: true, mode: 0o700 });

  async function readJson(file, fallback) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return fallback; throw error; }
  }
  async function atomicJson(file, value) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  }

  let users = await readJson(usersPath, []);
  let sessions = await readJson(sessionsPath, []);
  let workspace = await readJson(workforcePath, { tasks: [], reports: [] });
  if (!Array.isArray(users)) users = [];
  if (!Array.isArray(sessions)) sessions = [];
  if (!workspace || typeof workspace !== 'object') workspace = { tasks: [], reports: [] };
  workspace.tasks = Array.isArray(workspace.tasks) ? workspace.tasks : [];
  workspace.reports = Array.isArray(workspace.reports) ? workspace.reports : [];
  workspace.defectReports = Array.isArray(workspace.defectReports) ? workspace.defectReports : [];
  // GPS tracking was intentionally removed. Purge legacy coordinate histories from older 4.4 workspaces.
  const hadLegacyLocations = Object.prototype.hasOwnProperty.call(workspace, 'locations');
  delete workspace.locations;
  if (hadLegacyLocations) await atomicJson(workforcePath, workspace);
  const now = Date.now();
  sessions = sessions.filter(item => Number(item.expiresAt) > now && users.some(user => user.id === item.userId && user.active !== false));
  await atomicJson(sessionsPath, sessions);
  const saveUsers = () => atomicJson(usersPath, users);
  const saveSessions = () => atomicJson(sessionsPath, sessions);
  let workspaceWrite = Promise.resolve();
  let setupInProgress = false;
  let accountCreationInProgress = false;
  const saveWorkspace = () => {
    const pending = workspaceWrite.then(() => atomicJson(workforcePath, workspace));
    workspaceWrite = pending.catch(() => {});
    return pending;
  };

  const multer = (await import('multer')).default;
  const isAllowedImage = file => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    return /^\.(jpe?g|png|webp|tiff?|heic|heif)$/.test(ext)
      || /^image\/(jpeg|png|webp|tiff|x-tiff|heic|heif)$/.test(mime);
  };
  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 24 * 1024 * 1024, files: 1 },
    fileFilter(_req, file, cb) {
      if (file.fieldname === 'sketch') return cb(null, isAllowedImage(file));
      return cb(null, false);
    }
  });
  const defectUpload = multer({
    dest: uploadDir,
    limits: { fileSize: 16 * 1024 * 1024, files: 10 },
    fileFilter(_req, file, cb) {
      if (file.fieldname === 'defectPhotos') return cb(null, isAllowedImage(file));
      return cb(null, false);
    }
  });

  function getCurrentUser(req) {
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (!token) return null;
    const hash = tokenHash(token);
    const session = sessions.find(item => item.tokenHash === hash && Number(item.expiresAt) > Date.now());
    if (!session) return null;
    const user = users.find(item => item.id === session.userId && item.active !== false);
    return user || null;
  }
  function requireRoles(req, res, roles) {
    if (!req.user) { res.status(401).json({ error: 'Требуется войти в аккаунт.' }); return false; }
    if (!roles.includes(req.user.role)) { res.status(403).json({ error: 'Недостаточно прав для этого действия.' }); return false; }
    return true;
  }
  async function sessionForUser(res, user) {
    const token = randomBytes(32).toString('base64url');
    sessions.push({ tokenHash: tokenHash(token), userId: user.id, createdAt: new Date().toISOString(), expiresAt: Date.now() + SESSION_TTL_MS });
    await saveSessions();
    setSessionCookie(res, token, secureCookies);
  }
  function taskForClient(task) {
    const assignee = users.find(user => user.id === task.assignedTo);
    const taskReports = workspace.reports.filter(report => report.taskId === task.id);
    const latestReport = [...taskReports].sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)))[0] || null;
    const taskDefectReports = workspace.defectReports.filter(report => report.taskId === task.id);
    return {
      ...task, assignedName: assignee?.displayName || task.assignedName || 'Не назначен', reportsCount: taskReports.length,
      defectReportsCount: taskDefectReports.length,
      defectReports: taskDefectReports.map(defectReportForClient),
      events: Array.isArray(task.events) ? task.events : [],
      lastReviewComment: latestReport?.reviewComment || '', lastReportStatus: latestReport?.status || null,
      lastReviewedAt: latestReport?.reviewedAt || null
    };
  }
  function reportForClient(report) {
    const task = workspace.tasks.find(item => item.id === report.taskId);
    const author = users.find(user => user.id === report.userId);
    return {
      id: report.id, taskId: report.taskId, taskTitle: task?.title || report.taskTitle || 'Задание',
      street: task?.street || report.street || '', address: task?.address || report.address || '',
      scheduledDate: task?.scheduledDate || null, assignedName: task?.assignedName || null,
      userId: report.userId, userName: author?.displayName || report.userName || 'Сотрудник',
      note: report.note, status: report.status, reviewComment: report.reviewComment || '',
      submittedAt: report.submittedAt, reviewedAt: report.reviewedAt || null,
      schemeJobId: report.schemeJobId || null, manualCadProjectId: report.manualCadProjectId || null, schemeStatus: report.schemeStatus || 'queued',
      schemeError: report.schemeError || '', schemeCompletedAt: report.schemeCompletedAt || null,
      schemePartialGraphReady: Boolean(report.schemePartialGraphReady),
      seen: false,
      conclusionAddedAt: report.conclusionAddedAt || null,
      photos: (report.photos || []).map(file => ({ id: file.id, originalName: file.originalName, size: file.size, url: `/api/workforce/reports/${report.id}/files/${file.id}`, kind: file.kind })),
      sketch: report.sketch ? { id: report.sketch.id, originalName: report.sketch.originalName, size: report.sketch.size, url: `/api/workforce/reports/${report.id}/files/${report.sketch.id}`, kind: report.sketch.kind } : null
    };
  }

  function defectReportForClient(report) {
    const task = workspace.tasks.find(item => item.id === report.taskId);
    const author = users.find(user => user.id === report.userId);
    return {
      id: report.id, taskId: report.taskId,
      taskTitle: task?.title || report.taskTitle || 'Задание',
      street: task?.street || report.street || '',
      address: task?.address || report.address || '',
      scheduledDate: task?.scheduledDate || null, assignedName: task?.assignedName || null,
      userId: report.userId,
      userName: author?.displayName || report.userName || 'Сотрудник',
      note: report.note || '', status: report.status || 'pending_review',
      reviewComment: report.reviewComment || '', submittedAt: report.submittedAt,
      reviewedAt: report.reviewedAt || null,
      reviewedByName: users.find(user => user.id === report.reviewedBy)?.displayName || null,
      conclusionAddedAt: report.conclusionAddedAt || null,
      seen: false,
      photos: (report.photos || []).map(file => ({
        id: file.id, originalName: file.originalName, size: file.size, mimeType: file.mimeType,
        url: `/api/workforce/defects/${encodeURIComponent(report.id)}/files/${encodeURIComponent(file.id)}`
      }))
    };
  }

  async function authMiddleware(req, res, next) {
    const pathname = req.path;
    const authPublic = ['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/logout'];
    if (authPublic.includes(pathname) || pathname === '/api/health' || pathname === '/login' || pathname === '/login.html' || pathname === '/login.js' || pathname.startsWith('/login-assets/')) return next();

    req.user = publicUser(getCurrentUser(req));
    if ((pathname === '/login' || pathname === '/login.html') && req.user) return res.redirect('/');

    if (pathname.startsWith('/api/')) {
      if (!req.user) return res.status(401).json({ error: 'Сессия не найдена. Войди в аккаунт.', loginRequired: true });
      if (req.user.role === 'fitter' && !(pathname.startsWith('/api/workforce/') || pathname === '/api/auth/me')) {
        return res.status(403).json({ error: 'Слесарю доступны только личная панель, назначенные задания, отметки этапов работ и отправка ручной схемы.' });
      }
      if (req.user.role !== 'developer' && pathname.startsWith('/api/template') && req.method !== 'GET') return res.status(403).json({ error: 'Изменять глобальный шаблон может только разработчик.' });
      return next();
    }
    if (pathname.startsWith('/jobs/')) {
      if (!req.user) return res.status(401).json({ error: 'Требуется войти в аккаунт.' });
      if (req.user.role === 'fitter') return res.status(403).json({ error: 'Нет доступа к архиву обработки.' });
      return next();
    }

    const isAsset = /\.(?:css|js|png|jpe?g|webp|svg|ico|woff2?|map)$/i.test(pathname);
    if (!req.user && req.method === 'GET' && !isAsset && pathname !== '/login' && pathname !== '/login.html' && !pathname.startsWith('/vdgo/')) return res.redirect('/login');

    if (pathname === '/' || pathname === '/index.html') {
      if (!req.user) return res.redirect('/login');
      if (req.user.role === 'fitter') return res.redirect('/team');
    }
    if (pathname === '/manual-cad.html' && req.user?.role === 'fitter') return res.redirect('/team');
    if (pathname === '/workforce.html' || pathname === '/dashboard.html' || pathname === '/conclusion.html' || pathname === '/manual-cad.html' || pathname === '/login.html') {
      if (!req.user) return res.redirect('/login');
    }
    if (req.user?.role === 'fitter' && req.method === 'GET' && !/\.(?:css|js|png|jpe?g|webp|svg|ico|woff2?)$/i.test(pathname) && pathname !== '/team') {
      return res.redirect('/team');
    }
    return next();
  }

  const routes = (await import('express')).Router();

  routes.get('/api/auth/status', (_req, res) => res.json({ ok: true, setupRequired: users.length === 0 }));
  routes.post('/api/auth/setup', async (req, res) => {
    if (users.length || setupInProgress) return res.status(409).json({ error: 'Первоначальная настройка уже выполняется или завершена. Войди под аккаунтом разработчика.' });
    const username = cleanText(req.body?.username, 48).toLowerCase();
    const displayName = cleanText(req.body?.displayName, 100);
    const password = String(req.body?.password || '');
    if (!/^[a-z0-9._-]{3,48}$/.test(username)) return res.status(400).json({ error: 'Логин: от 3 до 48 символов, латиница, цифры, точка, дефис или подчёркивание.' });
    if (password.length < 10 || password.length > 200) return res.status(400).json({ error: 'Пароль должен содержать от 10 до 200 символов.' });
    if (!displayName) return res.status(400).json({ error: 'Укажи имя разработчика.' });
    setupInProgress = true;
    try {
      if (users.length) return res.status(409).json({ error: 'Первоначальная настройка уже завершена.' });
      const user = { id: randomUUID(), username, displayName, role: 'developer', passwordHash: await hashPassword(password), active: true, createdAt: new Date().toISOString() };
      users.push(user);
      await saveUsers();
      await sessionForUser(res, user);
      return res.status(201).json({ ok: true, user: publicUser(user) });
    } finally { setupInProgress = false; }
  });
  routes.post('/api/auth/login', async (req, res) => {
    const user = await authenticateCredentials(users, req.body?.username, req.body?.password);
    if (!user) return res.status(401).json({ error: 'Неверный логин или пароль.' });
    await sessionForUser(res, user);
    return res.json({ ok: true, user: publicUser(user) });
  });
  routes.post('/api/auth/logout', async (req, res) => {
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    const hash = token ? tokenHash(token) : '';
    sessions = sessions.filter(item => item.tokenHash !== hash);
    await saveSessions();
    clearSessionCookie(res, secureCookies);
    return res.json({ ok: true });
  });
  routes.get('/api/auth/me', (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Войди в аккаунт.' });
    return res.json({ ok: true, user: publicUser(user) });
  });

  routes.get('/api/auth/check-vdgo', (_req, res) => res.sendStatus(204));

  routes.get('/api/workforce/tasks', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Требуется войти.' });
    const tasks = workspace.tasks
      .filter(task => req.user.role !== 'fitter' || task.assignedTo === req.user.id)
      .sort((a, b) => String(a.scheduledDate).localeCompare(String(b.scheduledDate)) || String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(taskForClient);
    return res.json({ ok: true, tasks });
  });

  routes.post('/api/workforce/tasks', async (req, res) => {
    // Dispatchers (receivers), supervisors and developers can assign jobs to fitters.
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const assignedTo = cleanText(req.body?.assignedTo, 80);
    const fitter = users.find(user => user.id === assignedTo && user.role === 'fitter' && user.active !== false);
    const title = cleanText(req.body?.title, 160);
    const street = cleanText(req.body?.street, 180);
    const scheduledDate = cleanText(req.body?.scheduledDate, 10);
    let addresses = [];
    try {
      // New UI submits one house per line; legacy clients can still submit `address`.
      addresses = parseHouseAddresses(req.body?.addresses, req.body?.address);
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Проверь список домов.' });
    }
    if (!fitter) return res.status(400).json({ error: 'Выбери действующий аккаунт слесаря.' });
    if (!title || !street || !addresses.length || !validIsoDate(scheduledDate)) {
      return res.status(400).json({ error: 'Заполни работу, улицу, хотя бы один дом, дату и слесаря.' });
    }
    const nowIso = new Date().toISOString();
    const assignmentGroupId = randomUUID();
    const instructions = cleanText(req.body?.instructions, 1200);
    const createdTasks = addresses.map(address => ({
      id: randomUUID(), assignmentGroupId, title, street, address, instructions,
      scheduledDate, assignedTo: fitter.id, assignedName: fitter.displayName, status: 'assigned',
      createdBy: req.user.id, createdAt: nowIso, updatedAt: nowIso,
      startedAt: null, visitedAt: null, officeAt: null, completedAt: null, events: []
    }));
    workspace.tasks.unshift(...createdTasks);
    await saveWorkspace();
    const clientTasks = createdTasks.map(taskForClient);
    return res.status(201).json({
      ok: true, assignmentGroupId, createdCount: clientTasks.length,
      tasks: clientTasks, task: clientTasks[0]
    });
  });

  routes.post('/api/workforce/tasks/:id/start', async (req, res) => {
    if (!requireRoles(req, res, ['fitter', 'developer'])) return;
    const task = workspace.tasks.find(item => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Задание не найдено.' });
    if (req.user.role === 'fitter' && task.assignedTo !== req.user.id) return res.status(403).json({ error: 'Это задание назначено другому сотруднику.' });
    if (!['assigned', 'revision_requested', 'in_progress'].includes(task.status)) return res.status(409).json({ error: 'Это задание уже прошло этап выезда или отправлено.' });
    const timestamp = new Date().toISOString();
    task.status = 'in_progress';
    task.startedAt ||= timestamp;
    task.visitedAt = null;
    task.officeAt = null;
    task.events = Array.isArray(task.events) ? task.events : [];
    task.events.push({ type: 'started', label: 'Начал обход дома', at: timestamp, userId: req.user.id, userName: req.user.displayName });
    task.updatedAt = timestamp;
    await saveWorkspace();
    return res.json({ ok: true, task: taskForClient(task) });
  });

  routes.post('/api/workforce/tasks/:id/visit', async (req, res) => {
    if (!requireRoles(req, res, ['fitter', 'developer'])) return;
    const task = workspace.tasks.find(item => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Задание не найдено.' });
    if (req.user.role === 'fitter' && task.assignedTo !== req.user.id) return res.status(403).json({ error: 'Это задание назначено другому сотруднику.' });
    if (task.status !== 'in_progress') return res.status(409).json({ error: 'Сначала нажми «Начать обход дома».' });
    const timestamp = new Date().toISOString();
    task.status = 'house_visited';
    task.visitedAt = timestamp;
    task.events = Array.isArray(task.events) ? task.events : [];
    task.events.push({ type: 'house_visited', label: `Обход завершён: ${task.street}, дом ${task.address}`, at: timestamp, userId: req.user.id, userName: req.user.displayName });
    task.updatedAt = timestamp;
    await saveWorkspace();
    return res.json({ ok: true, task: taskForClient(task) });
  });

  routes.post('/api/workforce/tasks/:id/office', async (req, res) => {
    if (!requireRoles(req, res, ['fitter', 'developer'])) return;
    const task = workspace.tasks.find(item => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Задание не найдено.' });
    if (req.user.role === 'fitter' && task.assignedTo !== req.user.id) return res.status(403).json({ error: 'Это задание назначено другому сотруднику.' });
    if (task.status !== 'house_visited' || !task.visitedAt) return res.status(409).json({ error: 'Сначала отметь, что обход дома завершён.' });
    const timestamp = new Date().toISOString();
    task.status = 'at_office';
    task.officeAt = timestamp;
    task.events = Array.isArray(task.events) ? task.events : [];
    task.events.push({ type: 'office_arrival', label: 'Пришёл в офис', at: timestamp, userId: req.user.id, userName: req.user.displayName });
    task.updatedAt = timestamp;
    await saveWorkspace();
    return res.json({ ok: true, task: taskForClient(task) });
  });

  routes.post('/api/workforce/tasks/:id/report', (req, res, next) => {
    if (!req.user || !['fitter', 'developer'].includes(req.user.role)) return res.status(403).json({ error: 'Отправлять полевые отчёты может слесарь.' });
    upload.fields([{ name: 'sketch', maxCount: 1 }])(req, res, error => error ? next(error) : next());
  }, async (req, res) => {
    const task = workspace.tasks.find(item => item.id === req.params.id);
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
      return res.status(400).json({ error: 'Прикрепи изображение ручного эскиза (JPG, PNG, WEBP или TIFF). Фотографии дефектов отправляются отдельно.' });
    }
    const reportId = randomUUID();
    const reportDir = path.join(reportFilesDir, reportId);
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    async function persistFile(file, kind) {
      const id = randomUUID();
      const ext = path.extname(path.basename(file.originalname || '')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12) || (file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
      const fileName = `${id}${ext}`;
      await persistUploadedFile(file.path, path.join(reportDir, fileName));
      return { id, fileName, originalName: cleanText(path.basename(file.originalname || 'Файл'), 180), size: file.size, mimeType: file.mimetype, kind, uploadedAt: new Date().toISOString() };
    }
    try {
      const sketch = await persistFile(sketchFiles[0], 'sketch');
      const author = users.find(user => user.id === req.user.id);
      const report = {
        id: reportId, taskId: task.id, taskTitle: task.title, street: task.street, address: task.address,
        userId: req.user.id, userName: author?.displayName || req.user.displayName,
        note: cleanText(req.body?.note, 1800), photos: [], sketch,
        status: 'processing', submittedAt: new Date().toISOString(), reviewComment: '', reviewedAt: null,
        seenBy: [], conclusionAddedAt: null, schemeJobId: null, schemeStatus: 'queued', schemeError: '', schemeCompletedAt: null
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
          report.schemeError = cleanText(processingError?.message || 'Не удалось поставить эскиз в очередь автоматической обработки.', 900);
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
      return res.status(201).json({ ok: true, report: reportForClient(report) });
    } catch (error) {
      await rm(reportDir, { recursive: true, force: true }).catch(() => {});
      for (const file of sketchFiles) await rm(file.path, { force: true }).catch(() => {});
      return res.status(500).json({ error: `Не удалось сохранить отчёт: ${error.message}` });
    }
  });

  // Defect photos are a separate review queue. They do not enter CAD processing or Section 7.
  routes.post('/api/workforce/tasks/:id/defects', (req, res, next) => {
    if (!req.user || !['fitter', 'developer'].includes(req.user.role)) return res.status(403).json({ error: 'Отправлять фотографии дефектов может слесарь.' });
    defectUpload.array('defectPhotos', 10)(req, res, error => error ? next(error) : next());
  }, async (req, res) => {
    const uploaded = Array.isArray(req.files) ? req.files : [];
    const cleanupUploads = async () => Promise.all(uploaded.map(file => rm(file.path, { force: true }).catch(() => {})));
    const task = workspace.tasks.find(item => item.id === req.params.id);
    if (!task) { await cleanupUploads(); return res.status(404).json({ error: 'Задание не найдено.' }); }
    if (req.user.role === 'fitter' && task.assignedTo !== req.user.id) {
      await cleanupUploads();
      return res.status(403).json({ error: 'Нельзя отправить фотографии по чужому заданию.' });
    }
    if (!task.visitedAt || !task.officeAt) {
      await cleanupUploads();
      return res.status(409).json({ error: 'Сначала отметь, что дом пройден и ты пришёл в офис.' });
    }
    if (!uploaded.length) return res.status(400).json({ error: 'Добавь хотя бы одну фотографию дефекта (JPG, PNG, WEBP, TIFF или HEIC).' });

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
        const ext = path.extname(path.basename(file.originalname || '')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12)
          || ({ 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'image/tiff': '.tiff', 'image/x-tiff': '.tiff' }[file.mimetype] || '.jpg');
        const fileName = `${id}${ext}`;
        await persistUploadedFile(file.path, path.join(reportDir, fileName));
        photos.push({ id, fileName, originalName: cleanText(path.basename(file.originalname || 'Фото дефекта'), 180), size: file.size, mimeType: file.mimetype, uploadedAt: new Date().toISOString() });
      }
      const author = users.find(user => user.id === req.user.id);
      const report = {
        id: reportId, taskId: task.id, taskTitle: task.title, street: task.street, address: task.address,
        userId: req.user.id, userName: author?.displayName || req.user.displayName,
        note: cleanText(req.body?.note, 1200), photos,
        status: 'pending_review', submittedAt: new Date().toISOString(),
        seenBy: [], reviewComment: '', reviewedAt: null, reviewedBy: null
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
      task.events.push({ type: 'defects_submitted', label: `Отправлены фотографии дефектов: ${photos.length} шт.`, at: createdEventAt, userId: req.user.id, userName: req.user.displayName });
      task.updatedAt = report.submittedAt;
      await saveWorkspace();
      return res.status(201).json({ ok: true, report: defectReportForClient(report) });
    } catch (error) {
      if (createdReport) workspace.defectReports = workspace.defectReports.filter(item => item.id !== createdReport.id);
      if (createdEventAt && Array.isArray(task.events)) {
        task.events = task.events.filter(event => !(event.type === 'defects_submitted' && event.at === createdEventAt && event.userId === req.user.id));
      }
      task.updatedAt = previousTaskUpdatedAt;
      await rm(reportDir, { recursive: true, force: true }).catch(() => {});
      await cleanupUploads();
      return res.status(500).json({ error: `Не удалось сохранить фотографии дефектов: ${error.message}` });
    }
  });

  routes.get('/api/workforce/defects', (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const list = workspace.defectReports.filter(report => report.status !== 'superseded').map(report => ({
      ...defectReportForClient(report),
      seen: Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id)
    }));
    return res.json({
      ok: true,
      reports: list,
      unreadCount: list.filter(report => !report.seen && report.status === 'pending_review').length,
      pendingCount: list.filter(report => report.status === 'pending_review').length
    });
  });

  routes.post('/api/workforce/defects/:id/seen', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = workspace.defectReports.find(item => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Отчёт о дефектах не найден.' });
    report.seenBy = Array.isArray(report.seenBy) ? report.seenBy : [];
    if (!report.seenBy.includes(req.user.id)) report.seenBy.push(req.user.id);
    report.lastSeenAt = new Date().toISOString();
    await saveWorkspace();
    return res.json({ ok: true, seen: true });
  });

  routes.post('/api/workforce/defects/:id/review', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = workspace.defectReports.find(item => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Отчёт о дефектах не найден.' });
    if (req.user.role === 'receiver' && !(Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id))) {
      return res.status(409).json({ error: 'Сначала открой фотографии дефектов.' });
    }
    const status = String(req.body?.status || '');
    if (!['accepted', 'revision_requested'].includes(status)) return res.status(400).json({ error: 'Подтверди, что фотографии подходят, или верни отчёт.' });
    report.status = status;
    report.reviewComment = cleanText(req.body?.comment, 1200);
    report.reviewedAt = new Date().toISOString();
    report.reviewedBy = req.user.id;
    await saveWorkspace();
    return res.json({ ok: true, report: defectReportForClient(report) });
  });

  routes.get('/api/workforce/defects/:reportId/files/:fileId', (req, res) => {
    if (!req.user || !['fitter', 'receiver', 'supervisor', 'developer'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Нет доступа к фотографиям дефектов.' });
    }
    const report = workspace.defectReports.find(item => item.id === req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Отчёт о дефектах не найден.' });
    if (req.user.role === 'fitter' && report.userId !== req.user.id) return res.status(403).json({ error: 'Нет доступа к этой фотографии.' });
    const file = (report.photos || []).find(item => item.id === req.params.fileId);
    if (!file || !/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(file.fileName || '')) return res.status(404).json({ error: 'Фотография не найдена.' });
    const fullPath = path.join(reportFilesDir, report.id, file.fileName);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.originalName || 'defect-photo')}`);
    return res.sendFile(fullPath, error => { if (error && !res.headersSent) res.status(404).json({ error: 'Фотография дефекта недоступна.' }); });
  });

  async function refreshSchemeState(report) {
    if (!report?.schemeJobId || typeof getSketchStatus !== 'function') return;
    try {
      const state = await getSketchStatus(report.schemeJobId);
      if (state?.status) report.schemeStatus = state.status;
      if (state?.error !== undefined) report.schemeError = cleanText(state.error, 900);
      if (state?.completedAt) report.schemeCompletedAt = state.completedAt;
      if (state?.partialGraphReady) report.schemePartialGraphReady = true;
      const hasReviewableResult = report.schemeStatus === 'completed' || (report.schemeStatus === 'failed' && report.schemePartialGraphReady);
      if (hasReviewableResult) {
        if (!['accepted', 'revision_requested'].includes(report.status)) report.status = 'pending_review';
        const task = workspace.tasks.find(item => item.id === report.taskId);
        if (task && task.status === 'submitted') task.status = 'pending_review';
      } else if (report.schemeStatus === 'failed') {
        report.status = 'processing_failed';
        const task = workspace.tasks.find(item => item.id === report.taskId);
        if (task && task.status === 'submitted') task.status = 'processing_failed';
      }
    } catch (error) { report.schemeError = cleanText(error?.message || 'Не удалось проверить состояние CAD-обработки.', 900); }
  }

  routes.get('/api/workforce/reports', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    for (const report of workspace.reports) await refreshSchemeState(report);
    await saveWorkspace();
    const reports = workspace.reports
      .filter(report => req.user.role !== 'receiver' || ['processing', 'processing_failed', 'pending_review', 'accepted', 'revision_requested'].includes(report.status))
      .map(report => ({ ...reportForClient(report), seen: Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id) }));
    return res.json({ ok: true, reports, unreadCount: workspace.reports.filter(report => report.status !== 'superseded' && (!Array.isArray(report.seenBy) || !report.seenBy.includes(req.user.id))).length });
  });

  routes.post('/api/workforce/reports/:id/seen', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = workspace.reports.find(item => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Уведомление не найдено.' });
    report.seenBy = Array.isArray(report.seenBy) ? report.seenBy : [];
    if (!report.seenBy.includes(req.user.id)) report.seenBy.push(req.user.id);
    report.lastSeenAt = new Date().toISOString();
    await saveWorkspace();
    return res.json({ ok: true, seen: true });
  });

  routes.post('/api/workforce/reports/:id/conclusion', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    return res.status(409).json({ error: 'Теперь схемы добавляются только целой папкой адреса. Открой уведомления по дому и нажми «Добавить папку в заключение».' });
  });

  routes.post('/api/workforce/defects/:id/conclusion', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    return res.status(409).json({ error: 'Фотографии дефектов добавляются только вместе со всей папкой адреса. Открой уведомления по дому и нажми «Добавить папку в заключение».' });
  });

  routes.post('/api/workforce/tasks/:taskId/conclusion', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const task = workspace.tasks.find(item => item.id === req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Папка задания по этому адресу не найдена.' });

    const allTaskSchemes = workspace.reports.filter(report => report.taskId === task.id);
    const allTaskDefects = workspace.defectReports.filter(report => report.taskId === task.id);
    for (const report of allTaskSchemes) await refreshSchemeState(report);
    await saveWorkspace();
    const folderState = evaluateAddressFolder({ schemes: allTaskSchemes, defects: allTaskDefects, userId: req.user.role === 'receiver' ? req.user.id : null });
    const schemeReports = folderState.schemes;
    const defectReports = folderState.defects;
    const materialReports = folderState.items;
    if (!materialReports.length) return res.status(409).json({ error: 'В папке пока нет отправленных схем или фотографий дефектов.' });
    if (folderState.unseenCount) return res.status(409).json({ error: 'Сначала открой папку и просмотри все схемы и фотографии дефектов.' });
    if (!folderState.allAccepted) {
      const schemesPending = schemeReports.filter(report => report.status !== 'accepted').length;
      const defectsPending = defectReports.filter(report => report.status !== 'accepted').length;
      return res.status(409).json({ error: `Нельзя перенести папку целиком: сначала прими все материалы. Не приняты схемы: ${schemesPending}, отчёты о дефектах: ${defectsPending}.` });
    }
    if (!folderState.schemesReady) return res.status(409).json({ error: 'CAD-обработка ещё не готова для одной или нескольких схем. Дождись завершения и повтори перенос папки.' });
    if (!folderState.photosReady) return res.status(409).json({ error: 'В одном из отчётов о дефектах нет прикреплённых фотографий. Проверь папку.' });

    const addedAt = new Date().toISOString();
    const previousValues = materialReports.map(report => ({ report, conclusionAddedAt: report.conclusionAddedAt || null, conclusionAddedBy: report.conclusionAddedBy || null }));
    const previousFolderValues = {
      conclusionFolderAddedAt: task.conclusionFolderAddedAt || null,
      conclusionFolderAddedBy: task.conclusionFolderAddedBy || null
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
      if (previousFolderValues.conclusionFolderAddedAt) task.conclusionFolderAddedAt = previousFolderValues.conclusionFolderAddedAt;
      else delete task.conclusionFolderAddedAt;
      if (previousFolderValues.conclusionFolderAddedBy) task.conclusionFolderAddedBy = previousFolderValues.conclusionFolderAddedBy;
      else delete task.conclusionFolderAddedBy;
      return res.status(500).json({ error: `Не удалось сохранить папку в заключение: ${error.message}` });
    }
    return res.json({
      ok: true,
      folder: { taskId: task.id, street: task.street, address: task.address, schemesCount: schemeReports.length, defectReportsCount: defectReports.length, photosCount: defectReports.reduce((sum, report) => sum + (report.photos || []).length, 0), addedAt },
      conclusionUrl: `/conclusion.html?task=${encodeURIComponent(task.id)}`
    });
  });

  routes.get('/api/workforce/conclusion', (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    let taskId = cleanText(req.query.task, 120);
    if (!taskId && req.query.report) {
      const target = workspace.reports.find(item => item.id === String(req.query.report));
      if (target?.conclusionAddedAt && target.status === 'accepted') taskId = target.taskId;
    }
    if (!taskId && req.query.defectReport) {
      const target = workspace.defectReports.find(item => item.id === String(req.query.defectReport));
      if (target?.conclusionAddedAt && target.status === 'accepted') taskId = target.taskId;
    }
    if (!taskId) return res.json({ ok: true, task: null, reports: [], defectReports: [] });
    const task = workspace.tasks.find(item => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задание или адрес для заключения не найден.' });
    const reports = workspace.reports.filter(report => report.taskId === taskId && Boolean(report.conclusionAddedAt) && report.status === 'accepted').map(report => {
      const manualCadBase = report.manualCadProjectId ? `/api/manual-cad/projects/${encodeURIComponent(report.manualCadProjectId)}` : null;
      return {
        ...reportForClient(report),
        schemeSvgUrl: manualCadBase ? `${manualCadBase}/preview.svg` : report.schemeJobId ? `/jobs/${report.schemeJobId}/clean.svg` : null,
        schemeDxfUrl: manualCadBase ? `${manualCadBase}/export.dxf` : report.schemeJobId ? `/jobs/${report.schemeJobId}/drawing.dxf` : null,
        schemeOriginalUrl: report.sketch ? `/api/workforce/reports/${encodeURIComponent(report.id)}/files/${encodeURIComponent(report.sketch.id)}` : null
      };
    });
    const defectReports = workspace.defectReports
      .filter(report => report.taskId === taskId && Boolean(report.conclusionAddedAt) && report.status === 'accepted')
      .map(defectReportForClient);
    return res.json({
      ok: true,
      task: { id: task.id, title: task.title, street: task.street, address: task.address, scheduledDate: task.scheduledDate },
      reports,
      defectReports
    });
  });

  routes.post('/api/workforce/reports/:id/review', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = workspace.reports.find(item => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Отчёт не найден.' });
    if (req.user.role === 'receiver' && !(Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id))) {
      return res.status(409).json({ error: 'Сначала открой папку адреса и просмотри эту схему.' });
    }
    const status = String(req.body?.status || '');
    if (!['accepted', 'revision_requested'].includes(status)) return res.status(400).json({ error: 'Выбери приёмку или возврат на исправление.' });
    report.status = status;
    report.reviewComment = cleanText(req.body?.comment, 1200);
    report.reviewedAt = new Date().toISOString();
    const task = workspace.tasks.find(item => item.id === report.taskId);
    if (task) {
      task.status = status;
      task.updatedAt = report.reviewedAt;
      if (status === 'revision_requested') { task.completedAt = null; task.visitedAt = null; task.officeAt = null; }
    }
    await saveWorkspace();
    return res.json({ ok: true, report: reportForClient(report), task: task ? taskForClient(task) : null });
  });

  routes.get('/api/workforce/reports/:reportId/files/:fileId', async (req, res) => {
    const report = workspace.reports.find(item => item.id === req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Отчёт не найден.' });
    if (req.user.role === 'fitter' && report.userId !== req.user.id) return res.status(403).json({ error: 'Нет доступа к этому файлу.' });
    const file = [...(report.photos || []), ...(report.sketch ? [report.sketch] : [])].find(item => item.id === req.params.fileId);
    if (!file || !/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(file.fileName)) return res.status(404).json({ error: 'Файл не найден.' });
    const fullPath = path.join(reportFilesDir, report.id, file.fileName);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.originalName || 'report-file')}`);
    return res.sendFile(fullPath, error => { if (error && !res.headersSent) res.status(404).json({ error: 'Файл отчёта недоступен.' }); });
  });

  routes.get('/api/workforce/overview', (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const visibleUsers = users.filter(user => user.active !== false && (req.user.role === 'receiver' ? ['fitter', 'supervisor'].includes(user.role) : user.role !== 'developer'));
    const userList = visibleUsers.map(user => ({
      ...publicUser(user),
      assignedTasks: workspace.tasks.filter(task => task.assignedTo === user.id && !['accepted'].includes(task.status)).length,
      activeTask: workspace.tasks.find(task => task.assignedTo === user.id && !['accepted', 'submitted'].includes(task.status)) ? taskForClient(workspace.tasks.find(task => task.assignedTo === user.id && !['accepted', 'submitted'].includes(task.status))) : null
    }));
    return res.json({
      ok: true,
      users: userList,
      tasks: workspace.tasks.map(taskForClient),
      reports: workspace.reports.map(reportForClient),
      defectReports: workspace.defectReports.map(defectReportForClient),
      summary: {
        activeFitters: users.filter(user => user.active !== false && user.role === 'fitter').length,
        assigned: workspace.tasks.filter(task => ['assigned', 'in_progress'].includes(task.status)).length,
        submitted: workspace.tasks.filter(task => task.status === 'submitted').length,
        pendingReports: workspace.reports.filter(report => report.status === 'pending_review').length,
        pendingDefects: workspace.defectReports.filter(report => report.status === 'pending_review').length
      }
    });
  });

  routes.get('/api/workforce/users', (req, res) => {
    if (!requireRoles(req, res, ['supervisor', 'developer'])) return;
    const visible = req.user.role === 'supervisor' ? users.filter(user => ['fitter', 'receiver'].includes(user.role)) : users;
    return res.json({ ok: true, users: visible.map(publicUser) });
  });

  function makeLogin(displayName) {
    const transliteration = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
    const base = String(displayName || '').toLowerCase().split('').map(char => transliteration[char] ?? char).join('').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 34) || 'employee';
    let candidate = base;
    let suffix = 2;
    while (users.some(user => user.username.toLowerCase() === candidate.toLowerCase())) candidate = `${base.slice(0, 42)}.${suffix++}`;
    return candidate;
  }

  routes.post('/api/workforce/users', async (req, res) => {
    const allowedCreators = ['supervisor', 'developer'];
    if (!requireRoles(req, res, allowedCreators)) return;
    const displayName = cleanText(req.body?.displayName, 100);
    const { firstName, lastName } = splitHumanName(displayName);
    const role = String(req.body?.role || '');
    if (req.user.role === 'supervisor' && !['fitter', 'receiver'].includes(role)) return res.status(403).json({ error: 'Руководитель может создавать только аккаунты слесарей и приёмщиков.' });
    if (!firstName || !lastName) return res.status(400).json({ error: 'Укажи имя и фамилию сотрудника.' });
    if (!VALID_ROLES.has(role)) return res.status(400).json({ error: 'Неизвестная роль.' });
    const autoGenerate = req.body?.autoGenerate !== false;
    const username = autoGenerate ? makeLogin(displayName) : cleanText(req.body?.username, 48).toLowerCase();
    const password = autoGenerate ? randomBytes(12).toString('base64url') : String(req.body?.password || '');
    if (!/^[a-z0-9._-]{3,48}$/.test(username)) return res.status(400).json({ error: 'Логин: от 3 до 48 символов, латиница, цифры, точка, дефис или подчёркивание.' });
    if (password.length < 10 || password.length > 200) return res.status(400).json({ error: 'Пароль должен содержать от 10 до 200 символов.' });
    if (accountCreationInProgress) return res.status(409).json({ error: 'Создание другого аккаунта уже выполняется. Повтори попытку.' });
    accountCreationInProgress = true;
    try {
      if (users.some(user => user.username.toLowerCase() === username)) return res.status(409).json({ error: 'Такой логин уже занят.' });
      if (role === 'supervisor' && users.filter(user => user.role === 'supervisor' && user.active !== false).length >= 2) return res.status(409).json({ error: 'Можно создать только двух действующих руководителей.' });
      const user = { id: randomUUID(), username, displayName, firstName, lastName, role, passwordHash: await hashPassword(password), active: true, createdAt: new Date().toISOString() };
      users.push(user);
      await saveUsers();
      return res.status(201).json({ ok: true, user: publicUser(user), credentials: { username, password, generated: autoGenerate } });
    } finally { accountCreationInProgress = false; }
  });

  routes.post('/api/workforce/users/:id/reset-password', async (req, res) => {
    if (!requireRoles(req, res, ['supervisor', 'developer'])) return;
    const user = users.find(item => item.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Аккаунт не найден.' });
    if (!['fitter', 'receiver'].includes(user.role)) return res.status(403).json({ error: 'Через базу сотрудников можно переиздать пароль только слесарю или приёмщику.' });
    const password = randomBytes(15).toString('base64url');
    user.passwordHash = await hashPassword(password);
    user.updatedAt = new Date().toISOString();
    // Revoke previous sessions so the new password takes effect immediately.
    sessions = sessions.filter(session => session.userId !== user.id);
    await Promise.all([saveUsers(), saveSessions()]);
    return res.json({
      ok: true,
      user: publicUser(user),
      credentials: { username: user.username, password, reset: true }
    });
  });

  routes.patch('/api/workforce/users/:id', async (req, res) => {
    if (!requireRoles(req, res, ['developer'])) return;
    const user = users.find(item => item.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Аккаунт не найден.' });
    const displayName = req.body?.displayName === undefined ? user.displayName : cleanText(req.body.displayName, 100);
    const { firstName, lastName } = splitHumanName(displayName);
    const role = req.body?.role === undefined ? user.role : String(req.body.role);
    const active = req.body?.active === undefined ? user.active !== false : Boolean(req.body.active);
    const nextPassword = req.body?.password ? String(req.body.password) : '';
    if (!firstName || !lastName || !VALID_ROLES.has(role)) return res.status(400).json({ error: 'Проверь имя, фамилию и роль.' });
    if (nextPassword && (nextPassword.length < 10 || nextPassword.length > 200)) return res.status(400).json({ error: 'Новый пароль должен содержать от 10 до 200 символов.' });
    if (user.id === req.user.id && (!active || role !== 'developer')) return res.status(400).json({ error: 'Нельзя отключить или понизить собственный аккаунт разработчика.' });
    if (role === 'supervisor' && active && !(user.role === 'supervisor' && user.active !== false)) {
      const otherActiveSupervisors = users.filter(item => item.id !== user.id && item.role === 'supervisor' && item.active !== false).length;
      if (otherActiveSupervisors >= 2) return res.status(409).json({ error: 'Уже есть два действующих руководителя.' });
    }
    if (user.role === 'developer' && (role !== 'developer' || !active) && users.filter(item => item.role === 'developer' && item.active !== false).length <= 1) return res.status(409).json({ error: 'Нельзя отключить или убрать последнего разработчика.' });
    user.displayName = displayName;
    user.firstName = firstName;
    user.lastName = lastName;
    user.role = role;
    user.active = active;
    user.updatedAt = new Date().toISOString();
    if (nextPassword) user.passwordHash = await hashPassword(nextPassword);
    if (!active) {
      sessions = sessions.filter(session => session.userId !== user.id);
      await saveSessions();
    }
    await saveUsers();
    return res.json({ ok: true, user: publicUser(user) });
  });

  routes.get('/api/workforce/admin/diagnostics', (req, res) => {
    if (!requireRoles(req, res, ['developer'])) return;
    return res.json({ ok: true, version: '4.5.11', node: process.version, users: users.length, tasks: workspace.tasks.length, reports: workspace.reports.length, defectReports: workspace.defectReports.length, sessions: sessions.length, gpsTracking: false, manualSketchCadQueue: true, unifiedInbox: true, taskScopedConclusionTransfer: true, addressFolderInbox: true, atomicFolderConclusionTransfer: true, appendix3DefectPhotos: true, multiHouseDispatch: true, receiverCanAssignFitters: true, dataStore: 'persistent-json' });
  });

  async function linkManualCadProject(reportId, projectId) {
    const report = workspace.reports.find(item => item.id === reportId);
    if (!report || !projectId) return false;
    report.manualCadProjectId = String(projectId);
    await saveWorkspace();
    return true;
  }

  function getReport(reportId) { return workspace.reports.find(report => report.id === reportId) || null; }
  function getReportFilePath(reportId, fileId) {
    const report = getReport(reportId);
    if (!report) return null;
    const file = [...(report.photos || []), ...(report.sketch ? [report.sketch] : [])].find(item => item.id === fileId);
    if (!file || !/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(file.fileName || '')) return null;
    return path.join(reportFilesDir, report.id, file.fileName);
  }
  return { authMiddleware, router: routes, roleNames: ROLE_NAMES, getReport, getReportFilePath, linkManualCadProject };
}
