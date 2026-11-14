let clientPromise = null;

/**
 * PostgreSQL is opt-in during the expand phase. The JSON store remains the
 * source of truth, so the app must boot and serve requests even when Prisma is
 * not generated or DATABASE_URL is absent.
 */
export function postgresEnabled() {
  return process.env.AUTH_BACKEND === 'postgres' && Boolean(process.env.DATABASE_URL);
}

/**
 * PostgreSQL is the only system of record. Legacy JSON stores were removed after
 * the backup; callers that used to fall back to JSON must fail fast instead of
 * silently writing to disk.
 */
export function requirePostgres() {
  if (!postgresEnabled()) {
    const error = new Error(
      'PostgreSQL обязателен: задайте AUTH_BACKEND=postgres и DATABASE_URL. JSON-хранилище удалено (см. docs/MIGRATION-JSON-TO-POSTGRES-RU.md).',
    );
    error.code = 'POSTGRES_REQUIRED';
    throw error;
  }
  return true;
}

export function getPrismaClient() {
  if (!postgresEnabled()) return null;
  if (!clientPromise) {
    clientPromise = import('@prisma/client')
      .then(({ PrismaClient }) => new PrismaClient())
      .catch((error) => {
        clientPromise = null;
        throw error;
      });
  }
  return clientPromise;
}
