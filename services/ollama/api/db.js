let clientPromise = null;

/**
 * PostgreSQL is opt-in during the expand phase. The JSON store remains the
 * source of truth, so the app must boot and serve requests even when Prisma is
 * not generated or DATABASE_URL is absent.
 */
export function postgresEnabled() {
  return process.env.AUTH_BACKEND === 'postgres' && Boolean(process.env.DATABASE_URL);
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
