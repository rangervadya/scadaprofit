import { getPrismaClient, postgresEnabled } from './db.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'workspace' });

/**
 * Workforce workspace on normalized tables (P1-14).
 *
 * Tasks, reports and defect reports used to live in a single JSONB blob, so
 * "find the task assigned to X" meant scanning and rewriting the whole document.
 * Each entity now has its own row and index; `data` keeps the full payload so
 * fields the app does not promote to columns survive a round-trip.
 *
 * `fetchWorkspace()` returns exactly `{ tasks, reports, defectReports }`.
 */

export async function fetchWorkspace() {
  if (!postgresEnabled()) return null;
  const prisma = await getPrismaClient();
  const [tasks, reports, defectReports] = await Promise.all([
    prisma.workforceTask.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.workforceReport.findMany({ orderBy: { submittedAt: 'asc' } }),
    prisma.workforceDefectReport.findMany({ orderBy: { submittedAt: 'asc' } }),
  ]);
  if (!tasks.length && !reports.length && !defectReports.length) return null;
  return {
    tasks: tasks.map((row) => row.data ?? { id: row.id }),
    reports: reports.map((row) => row.data ?? { id: row.id }),
    defectReports: defectReports.map((row) => row.data ?? { id: row.id }),
  };
}

/**
 * Persist the workspace. Entities are upserted by id and rows that vanished are
 * deleted, all in one transaction. The legacy singleton is kept in sync so a
 * rollback to an older build still sees a coherent document.
 */
export async function saveWorkspace(workspace) {
  if (!postgresEnabled()) return false;
  const prisma = await getPrismaClient();
  const tasks = Array.isArray(workspace?.tasks) ? workspace.tasks : [];
  const reports = Array.isArray(workspace?.reports) ? workspace.reports : [];
  const defectReports = Array.isArray(workspace?.defectReports) ? workspace.defectReports : [];

  const taskIds = new Set();
  const reportIds = new Set();
  const defectIds = new Set();

  await prisma.$transaction(async (tx) => {
    for (const task of tasks) {
      const id = String(task?.id || '');
      if (!id) continue;
      taskIds.add(id);
      const row = {
        id,
        title: String(task.title || ''),
        status: String(task.status || 'assigned'),
        street: String(task.street || ''),
        address: String(task.address || ''),
        scheduledDate: task.scheduledDate ? String(task.scheduledDate) : null,
        assignedTo: task.assignedTo || null,
        assignedName: task.assignedName ? String(task.assignedName) : null,
        assignmentGroupId: task.assignmentGroupId || null,
        data: task,
      };
      await tx.workforceTask.upsert({
        where: { id },
        create: row,
        update: {
          title: row.title,
          status: row.status,
          street: row.street,
          address: row.address,
          scheduledDate: row.scheduledDate,
          assignedTo: row.assignedTo,
          assignedName: row.assignedName,
          assignmentGroupId: row.assignmentGroupId,
          data: row.data,
        },
      });
    }

    for (const report of reports) {
      const id = String(report?.id || '');
      if (!id) continue;
      reportIds.add(id);
      const row = {
        id,
        taskId: report.taskId || null,
        userId: report.userId || null,
        status: String(report.status || 'pending_review'),
        schemeJobId: report.schemeJobId || null,
        data: report,
        submittedAt: report.submittedAt ? new Date(report.submittedAt) : null,
        reviewedAt: report.reviewedAt ? new Date(report.reviewedAt) : null,
      };
      await tx.workforceReport.upsert({
        where: { id },
        create: row,
        update: {
          taskId: row.taskId,
          userId: row.userId,
          status: row.status,
          schemeJobId: row.schemeJobId,
          data: row.data,
          submittedAt: row.submittedAt,
          reviewedAt: row.reviewedAt,
        },
      });
    }

    for (const report of defectReports) {
      const id = String(report?.id || '');
      if (!id) continue;
      defectIds.add(id);
      const row = {
        id,
        taskId: report.taskId || null,
        userId: report.userId || null,
        status: String(report.status || 'pending_review'),
        data: report,
        submittedAt: report.submittedAt ? new Date(report.submittedAt) : null,
        reviewedAt: report.reviewedAt ? new Date(report.reviewedAt) : null,
      };
      await tx.workforceDefectReport.upsert({
        where: { id },
        create: row,
        update: {
          taskId: row.taskId,
          userId: row.userId,
          status: row.status,
          data: row.data,
          submittedAt: row.submittedAt,
          reviewedAt: row.reviewedAt,
        },
      });
    }

    const staleTasks = await tx.workforceTask.findMany({ select: { id: true } });
    const staleTaskIds = staleTasks.map((row) => row.id).filter((id) => !taskIds.has(id));
    if (staleTaskIds.length) await tx.workforceTask.deleteMany({ where: { id: { in: staleTaskIds } } });

    const staleReports = await tx.workforceReport.findMany({ select: { id: true } });
    const staleReportIds = staleReports.map((row) => row.id).filter((id) => !reportIds.has(id));
    if (staleReportIds.length) await tx.workforceReport.deleteMany({ where: { id: { in: staleReportIds } } });

    const staleDefects = await tx.workforceDefectReport.findMany({ select: { id: true } });
    const staleDefectIds = staleDefects.map((row) => row.id).filter((id) => !defectIds.has(id));
    if (staleDefectIds.length) await tx.workforceDefectReport.deleteMany({ where: { id: { in: staleDefectIds } } });
  });

  log.debug({ tasks: tasks.length, reports: reports.length, defects: defectReports.length }, 'Workspace saved');
  return true;
}
