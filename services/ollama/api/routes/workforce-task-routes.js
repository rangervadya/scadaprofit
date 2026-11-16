import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { logger } from '../lib/logger.js';

/**
 * Task routes (P2-1): list, dispatch (multi-house), start, visit, office,
 * reassign, delete.
 *
 * Mutating handlers read/write the workspace through accessors; `taskForClient`
 * is injected so the serializer stays the single source of truth.
 */
export function createTaskRouter(ctx) {
  const {
    getWorkspace,
    saveWorkspace,
    getUsers,
    requireRoles,
    cleanText,
    parseHouseAddresses,
    validIsoDate,
    taskForClient,
    sendJsonConditional,
    findIdempotency,
    saveIdempotency,
    reportFilesDir,
  } = ctx;

  const router = express.Router();

  router.get('/tasks', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Требуется войти.' });
    const tasks = getWorkspace()
      .tasks.filter((task) => req.user.role !== 'fitter' || task.assignedTo === req.user.id)
      .sort(
        (a, b) =>
          String(a.scheduledDate).localeCompare(String(b.scheduledDate)) ||
          String(b.createdAt).localeCompare(String(a.createdAt)),
      )
      .map(taskForClient);
    return sendJsonConditional(req, res, { ok: true, tasks });
  });

  router.post('/tasks', async (req, res) => {
    // Dispatchers (receivers), supervisors and developers can assign jobs to fitters.
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const idempotencyKey = cleanText(req.get('Idempotency-Key'), 200);
    if (idempotencyKey) {
      const existing = await findIdempotency('POST /api/workforce/tasks', idempotencyKey);
      if (existing) return res.status(existing.status).json(existing.response);
    }
    const assignedTo = cleanText(req.body?.assignedTo, 80);
    const fitter = getUsers().find((user) => user.id === assignedTo && user.role === 'fitter' && user.active !== false);
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
    const createdTasks = addresses.map((address) => ({
      id: randomUUID(),
      assignmentGroupId,
      title,
      street,
      address,
      instructions,
      scheduledDate,
      assignedTo: fitter.id,
      assignedName: fitter.displayName,
      status: 'assigned',
      createdBy: req.user.id,
      createdAt: nowIso,
      updatedAt: nowIso,
      startedAt: null,
      visitedAt: null,
      officeAt: null,
      completedAt: null,
      events: [],
    }));
    getWorkspace().tasks.unshift(...createdTasks);
    await saveWorkspace();
    const clientTasks = createdTasks.map(taskForClient);
    const payload = {
      ok: true,
      assignmentGroupId,
      createdCount: clientTasks.length,
      tasks: clientTasks,
      task: clientTasks[0],
    };
    if (idempotencyKey) {
      await saveIdempotency({
        endpoint: 'POST /api/workforce/tasks',
        key: idempotencyKey,
        userId: req.user.id,
        status: 201,
        response: payload,
      });
    }
    return res.status(201).json(payload);
  });

  function findTask(id) {
    return getWorkspace().tasks.find((item) => item.id === id) || null;
  }

  function findFitter(value) {
    const id = cleanText(value, 80);
    return getUsers().find((user) => user.id === id && user.role === 'fitter' && user.active !== false) || null;
  }

  /**
   * Remove a task with everything that belongs to one house visit: sketch
   * reports, defect photo sets and their uploaded files. CAD jobs are owned by
   * the scheme pipeline and are intentionally left alone.
   */
  function removeTask(task) {
    const workspace = getWorkspace();
    const reportIds = new Set();
    const defectIds = new Set();
    workspace.reports = workspace.reports.filter((report) => {
      if (report.taskId !== task.id) return true;
      reportIds.add(report.id);
      return false;
    });
    workspace.defectReports = workspace.defectReports.filter((report) => {
      if (report.taskId !== task.id) return true;
      defectIds.add(report.id);
      return false;
    });
    workspace.tasks = workspace.tasks.filter((item) => item.id !== task.id);
    return { reportIds: [...reportIds], defectIds: [...defectIds] };
  }

  async function removeReportFiles(ids) {
    await Promise.all(
      ids.map((id) =>
        rm(path.join(reportFilesDir, id), { recursive: true, force: true }).catch((error) => {
          logger.warn({ err: error, reportId: id }, 'Cannot remove uploaded report files');
        }),
      ),
    );
  }

  router.patch('/tasks/:id', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const task = findTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Задание не найдено.' });
    const assignedTo = cleanText(req.body?.assignedTo, 80);
    if (!assignedTo) return res.status(400).json({ error: 'Выбери слесаря.' });
    const fitter = findFitter(assignedTo);
    if (!fitter) return res.status(400).json({ error: 'Выбери действующий аккаунт слесаря.' });
    const previous = { assignedTo: task.assignedTo, assignedName: task.assignedName };
    if (previous.assignedTo === fitter.id) {
      return res.json({ ok: true, changed: false, task: taskForClient(task) });
    }
    const timestamp = new Date().toISOString();
    task.assignedTo = fitter.id;
    task.assignedName = fitter.displayName;
    task.updatedAt = timestamp;
    task.events = Array.isArray(task.events) ? task.events : [];
    task.events.push({
      type: 'reassigned',
      label: `Слесарь сменён: ${previous.assignedName || 'не назначен'} → ${fitter.displayName}`,
      at: timestamp,
      userId: req.user.id,
      userName: req.user.displayName,
    });
    await saveWorkspace();
    req.log.info(
      { taskId: task.id, from: previous.assignedTo, to: fitter.id, by: req.user.id },
      'Task fitter reassigned',
    );
    return res.json({ ok: true, changed: true, task: taskForClient(task) });
  });

  /**
   * Delete one house task, or a whole walk when `scope=group` is passed and the
   * task belongs to a multi-house dispatch. Managers only: fitters must not be
   * able to erase an assigned visit.
   */
  router.delete('/tasks/:id', async (req, res) => {
    if (!requireRoles(req, res, ['supervisor', 'developer'])) return;
    const task = findTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Задание не найдено.' });
    const scope = cleanText(req.query.scope, 20).toLowerCase();
    let targets = [task];
    if (scope === 'group' && task.assignmentGroupId) {
      targets = getWorkspace().tasks.filter((item) => item.assignmentGroupId === task.assignmentGroupId);
    }
    const removed = { tasks: 0, reports: 0, defects: 0 };
    const fileIds = [];
    for (const target of targets) {
      const result = removeTask(target);
      fileIds.push(...result.reportIds, ...result.defectIds);
      removed.tasks += 1;
      removed.reports += result.reportIds.length;
      removed.defects += result.defectIds.length;
    }
    try {
      await saveWorkspace();
    } catch (error) {
      req.log.error({ err: error, taskId: task.id, scope }, 'Failed to delete workforce task');
      return res.status(500).json({ error: `Не удалось удалить задание: ${error.message}` });
    }
    await removeReportFiles(fileIds);
    req.log.warn({ taskId: task.id, scope, removed, by: req.user.id }, 'Workforce task deleted');
    return res.json({ ok: true, removed });
  });

  router.post('/tasks/:id/start', async (req, res) => {
    if (!requireRoles(req, res, ['fitter', 'developer'])) return;
    const task = getWorkspace().tasks.find((item) => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Задание не найдено.' });
    if (req.user.role === 'fitter' && task.assignedTo !== req.user.id)
      return res.status(403).json({ error: 'Это задание назначено другому сотруднику.' });
    if (!['assigned', 'revision_requested', 'in_progress'].includes(task.status))
      return res.status(409).json({ error: 'Это задание уже прошло этап выезда или отправлено.' });
    const timestamp = new Date().toISOString();
    task.status = 'in_progress';
    task.startedAt ||= timestamp;
    task.visitedAt = null;
    task.officeAt = null;
    task.events = Array.isArray(task.events) ? task.events : [];
    task.events.push({
      type: 'started',
      label: 'Начал обход дома',
      at: timestamp,
      userId: req.user.id,
      userName: req.user.displayName,
    });
    task.updatedAt = timestamp;
    await saveWorkspace();
    return res.json({ ok: true, task: taskForClient(task) });
  });

  router.post('/tasks/:id/visit', async (req, res) => {
    if (!requireRoles(req, res, ['fitter', 'developer'])) return;
    const task = getWorkspace().tasks.find((item) => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Задание не найдено.' });
    if (req.user.role === 'fitter' && task.assignedTo !== req.user.id)
      return res.status(403).json({ error: 'Это задание назначено другому сотруднику.' });
    if (task.status !== 'in_progress') return res.status(409).json({ error: 'Сначала нажми «Начать обход дома».' });
    const timestamp = new Date().toISOString();
    task.status = 'house_visited';
    task.visitedAt = timestamp;
    task.events = Array.isArray(task.events) ? task.events : [];
    task.events.push({
      type: 'house_visited',
      label: `Обход завершён: ${task.street}, дом ${task.address}`,
      at: timestamp,
      userId: req.user.id,
      userName: req.user.displayName,
    });
    task.updatedAt = timestamp;
    await saveWorkspace();
    return res.json({ ok: true, task: taskForClient(task) });
  });

  router.post('/tasks/:id/office', async (req, res) => {
    if (!requireRoles(req, res, ['fitter', 'developer'])) return;
    const task = getWorkspace().tasks.find((item) => item.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Задание не найдено.' });
    if (req.user.role === 'fitter' && task.assignedTo !== req.user.id)
      return res.status(403).json({ error: 'Это задание назначено другому сотруднику.' });
    if (task.status !== 'house_visited' || !task.visitedAt)
      return res.status(409).json({ error: 'Сначала отметь, что обход дома завершён.' });
    const timestamp = new Date().toISOString();
    task.status = 'at_office';
    task.officeAt = timestamp;
    task.events = Array.isArray(task.events) ? task.events : [];
    task.events.push({
      type: 'office_arrival',
      label: 'Пришёл в офис',
      at: timestamp,
      userId: req.user.id,
      userName: req.user.displayName,
    });
    task.updatedAt = timestamp;
    await saveWorkspace();
    return res.json({ ok: true, task: taskForClient(task) });
  });

  return router;
}
