import { getPrismaClient, postgresEnabled } from './db.js';

function rowToProject(row) {
  return row?.data && typeof row.data === 'object' ? row.data : null;
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
