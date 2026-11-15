import { getPrismaClient, postgresEnabled } from './db.js';
import { manualProjectSchema, parseOrDefault } from '../validation/entities.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'postgres' });

function rowToProject(row) {
  return parseOrDefault(manualProjectSchema, row?.data, {
    label: 'manual_cad_project',
    fallback: null,
    log,
  });
}

export async function fetchManualProject(id) {
  if (!postgresEnabled() || !id) return null;
  const prisma = await getPrismaClient();
  const row = await prisma.manualCadProject.findUnique({ where: { id } });
  return rowToProject(row);
}

export async function fetchManualProjects() {
  if (!postgresEnabled()) return [];
  const prisma = await getPrismaClient();
  const rows = await prisma.manualCadProject.findMany({ orderBy: { updatedAt: 'desc' } });
  return rows.map(rowToProject).filter(Boolean);
}

export async function saveManualProject(project) {
  if (!postgresEnabled() || !project?.id) return false;
  const prisma = await getPrismaClient();
  const row = {
    id: project.id,
    title: String(project.title || ''),
    data: project,
    revision: Math.max(0, Number(project.manualEditRevision || 0)),
  };
  await prisma.manualCadProject.upsert({
    where: { id: project.id },
    create: row,
    update: { title: row.title, data: row.data, revision: row.revision },
  });
  return true;
}

/**
 * Optimistic concurrency save: writes only when the stored revision still
 * equals expectedRevision. Returns 'ok' | 'conflict' | 'missing'.
 * On conflict the caller must re-read and merge — no silent overwrite.
 */
export async function saveManualProjectIfRevision(project, expectedRevision) {
  if (!postgresEnabled() || !project?.id) return 'missing';
  const prisma = await getPrismaClient();
  const row = {
    id: project.id,
    title: String(project.title || ''),
    data: project,
    revision: Math.max(0, Number(project.manualEditRevision || 0)),
  };
  const expected = Math.max(0, Number(expectedRevision || 0));
  const result = await prisma.manualCadProject.updateMany({
    where: { id: project.id, revision: expected },
    data: { title: row.title, data: row.data, revision: row.revision },
  });
  if (result.count === 1) return 'ok';
  const exists = await prisma.manualCadProject.count({ where: { id: project.id } });
  return exists ? 'conflict' : 'missing';
}

export async function currentManualRevision(id) {
  if (!postgresEnabled() || !id) return null;
  const prisma = await getPrismaClient();
  const row = await prisma.manualCadProject.findUnique({
    where: { id },
    select: { revision: true },
  });
  return row ? Number(row.revision || 0) : null;
}

export async function deleteManualProject(id) {
  if (!postgresEnabled() || !id) return false;
  const prisma = await getPrismaClient();
  await prisma.manualCadProject.deleteMany({ where: { id } });
  return true;
}

export async function findManualProjectBySourceJob(jobId) {
  const projects = await fetchManualProjects();
  return projects.find((project) => project.sourceJobId === jobId) || null;
}

export async function findManualProjectBySourceReport(reportId) {
  const projects = await fetchManualProjects();
  return projects.find((project) => project.sourceReportId === reportId) || null;
}
