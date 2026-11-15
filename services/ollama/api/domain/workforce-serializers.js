/**
 * Client serializers and lookup indexes (P2-1).
 *
 * Moved from workforce-system.js verbatim. Pure functions over (users, workspace):
 * no request state, no I/O.
 */

export function buildLookups(users, workspace) {
  const usersById = new Map();
  for (const user of users) usersById.set(user.id, user);
  const tasksById = new Map();
  const reportsByTask = new Map();
  const defectsByTask = new Map();
  for (const task of workspace.tasks) tasksById.set(task.id, task);
  for (const report of workspace.reports) {
    const key = report.taskId || '';
    const bucket = reportsByTask.get(key);
    if (bucket) bucket.push(report);
    else reportsByTask.set(key, [report]);
  }
  for (const defect of workspace.defectReports) {
    const key = defect.taskId || '';
    const bucket = defectsByTask.get(key);
    if (bucket) bucket.push(defect);
    else defectsByTask.set(key, [defect]);
  }
  return { usersById, tasksById, reportsByTask, defectsByTask };
}

/**
 * Cached lookup set: rebuilt only after `invalidate()` (called on writes), so
 * serializing a list is O(1) per entity instead of O(n) (P2-5).
 */
export function createLookupCache(users, workspace) {
  let lookups = buildLookups(users, workspace);
  let dirty = false;
  return {
    invalidate() {
      dirty = true;
    },
    get() {
      if (dirty) {
        lookups = buildLookups(users, workspace);
        dirty = false;
      }
      return lookups;
    },
  };
}

export function taskForClient(task, lookups) {
  const { usersById, reportsByTask, defectsByTask } = lookups;
  const assignee = usersById.get(task.assignedTo);
  const taskReports = reportsByTask.get(task.id) || [];
  const latestReport =
    [...taskReports].sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)))[0] || null;
  const taskDefectReports = defectsByTask.get(task.id) || [];
  return {
    ...task,
    assignedName: assignee?.displayName || task.assignedName || 'Не назначен',
    reportsCount: taskReports.length,
    defectReportsCount: taskDefectReports.length,
    defectReports: taskDefectReports.map((report) => defectReportForClient(report, lookups)),
    events: Array.isArray(task.events) ? task.events : [],
    lastReviewComment: latestReport?.reviewComment || '',
    lastReportStatus: latestReport?.status || null,
    lastReviewedAt: latestReport?.reviewedAt || null,
  };
}

export function reportForClient(report, lookups) {
  const { tasksById, usersById } = lookups;
  const task = tasksById.get(report.taskId);
  const author = usersById.get(report.userId);
  return {
    id: report.id,
    taskId: report.taskId,
    taskTitle: task?.title || report.taskTitle || 'Задание',
    street: task?.street || report.street || '',
    address: task?.address || report.address || '',
    scheduledDate: task?.scheduledDate || null,
    assignedName: task?.assignedName || null,
    userId: report.userId,
    userName: author?.displayName || report.userName || 'Сотрудник',
    note: report.note,
    status: report.status,
    reviewComment: report.reviewComment || '',
    submittedAt: report.submittedAt,
    reviewedAt: report.reviewedAt || null,
    schemeJobId: report.schemeJobId || null,
    manualCadProjectId: report.manualCadProjectId || null,
    schemeStatus: report.schemeStatus || 'queued',
    schemeError: report.schemeError || '',
    schemeCompletedAt: report.schemeCompletedAt || null,
    schemePartialGraphReady: Boolean(report.schemePartialGraphReady),
    seen: false,
    conclusionAddedAt: report.conclusionAddedAt || null,
    photos: (report.photos || []).map((file) => ({
      id: file.id,
      originalName: file.originalName,
      size: file.size,
      url: `/api/workforce/reports/${report.id}/files/${file.id}`,
      kind: file.kind,
    })),
    sketch: report.sketch
      ? {
          id: report.sketch.id,
          originalName: report.sketch.originalName,
          size: report.sketch.size,
          url: `/api/workforce/reports/${report.id}/files/${report.sketch.id}`,
          kind: report.sketch.kind,
        }
      : null,
  };
}

export function defectReportForClient(report, lookups) {
  const { tasksById, usersById } = lookups;
  const task = tasksById.get(report.taskId);
  const author = usersById.get(report.userId);
  return {
    id: report.id,
    taskId: report.taskId,
    taskTitle: task?.title || report.taskTitle || 'Задание',
    street: task?.street || report.street || '',
    address: task?.address || report.address || '',
    scheduledDate: task?.scheduledDate || null,
    assignedName: task?.assignedName || null,
    userId: report.userId,
    userName: author?.displayName || report.userName || 'Сотрудник',
    note: report.note || '',
    status: report.status || 'pending_review',
    reviewComment: report.reviewComment || '',
    submittedAt: report.submittedAt,
    reviewedAt: report.reviewedAt || null,
    reviewedByName: usersById.get(report.reviewedBy)?.displayName || null,
    conclusionAddedAt: report.conclusionAddedAt || null,
    seen: false,
    photos: (report.photos || []).map((file) => ({
      id: file.id,
      originalName: file.originalName,
      size: file.size,
      mimeType: file.mimeType,
      url: `/api/workforce/defects/${encodeURIComponent(report.id)}/files/${encodeURIComponent(file.id)}`,
    })),
  };
}
