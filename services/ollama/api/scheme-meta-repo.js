import { getPrismaClient, postgresEnabled } from './db.js';

export async function fetchSchemeMeta(jobId) {
  if (!postgresEnabled() || !jobId) return null;
  const prisma = await getPrismaClient();
  const row = await prisma.schemeMeta.findUnique({ where: { jobId } });
  return row?.data && typeof row.data === 'object' ? row.data : null;
}

export async function saveSchemeMeta(jobId, meta) {
  if (!postgresEnabled() || !jobId) return false;
  const prisma = await getPrismaClient();
  const row = {
    jobId,
    status: String(meta?.status || 'completed'),
    data: meta,
  };
  await prisma.schemeMeta.upsert({
    where: { jobId },
    create: row,
    update: { status: row.status, data: row.data },
  });
  return true;
}

export async function fetchAllSchemeMeta() {
  if (!postgresEnabled()) return [];
  const prisma = await getPrismaClient();
  const rows = await prisma.schemeMeta.findMany({ orderBy: { updatedAt: 'desc' } });
  return rows.map((row) => row.data).filter((item) => item && typeof item === 'object');
}
