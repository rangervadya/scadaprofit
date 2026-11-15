import { getPrismaClient, postgresEnabled } from './db.js';
import { parseOrDefault, schemeMetaSchema } from './entities.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'postgres' });

export async function fetchSchemeMeta(jobId) {
  if (!postgresEnabled() || !jobId) return null;
  const prisma = await getPrismaClient();
  const row = await prisma.schemeMeta.findUnique({ where: { jobId } });
  return parseOrDefault(schemeMetaSchema, row?.data, { label: 'scheme_meta', fallback: null, log });
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
  return rows
    .map((row) => parseOrDefault(schemeMetaSchema, row.data, { label: 'scheme_meta', fallback: null, log }))
    .filter(Boolean);
}
