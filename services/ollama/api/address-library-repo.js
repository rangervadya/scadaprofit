import { getPrismaClient, postgresEnabled } from './db.js';
import { addressLibrarySchema, parseOrDefault } from './entities.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'postgres' });

const SINGLETON_ID = 1;

export async function fetchAddressLibrary() {
  if (!postgresEnabled()) return null;
  const prisma = await getPrismaClient();
  const row = await prisma.addressLibrary.findUnique({ where: { id: SINGLETON_ID } });
  return parseOrDefault(addressLibrarySchema, row?.data, {
    label: 'address_library',
    fallback: null,
    log,
  });
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
