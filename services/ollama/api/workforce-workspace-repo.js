import { getPrismaClient, postgresEnabled } from './db.js';
import { parseOrDefault, workspaceSchema } from './entities.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'postgres' });

const SINGLETON_ID = 1;

export async function fetchWorkspace() {
  if (!postgresEnabled()) return null;
  const prisma = await getPrismaClient();
  const row = await prisma.workforceWorkspace.findUnique({ where: { id: SINGLETON_ID } });
  return parseOrDefault(workspaceSchema, row?.data, {
    label: 'workforce_workspace',
    fallback: null,
    log,
  });
}

export async function saveWorkspace(workspace) {
  if (!postgresEnabled()) return false;
  const prisma = await getPrismaClient();
  await prisma.workforceWorkspace.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, data: workspace },
    update: { data: workspace },
  });
  return true;
}
