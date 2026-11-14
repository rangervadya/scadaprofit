import { getPrismaClient, postgresEnabled } from './db.js';

const SINGLETON_ID = 1;

export async function fetchAddressLibrary() {
  if (!postgresEnabled()) return null;
  const prisma = await getPrismaClient();
  const row = await prisma.addressLibrary.findUnique({ where: { id: SINGLETON_ID } });
  return row?.data && typeof row.data === 'object' ? row.data : null;
}

export async function saveAddressLibrary(library) {
  if (!postgresEnabled()) return false;
  const prisma = await getPrismaClient();
  await prisma.addressLibrary.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, schemaVersion: Number(library?.schemaVersion || 1), data: library },
    update: { schemaVersion: Number(library?.schemaVersion || 1), data: library },
  });
  return true;
}
