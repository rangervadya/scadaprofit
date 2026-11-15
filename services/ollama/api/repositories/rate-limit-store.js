import { getPrismaClient, postgresEnabled } from './db.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'ratelimit-store' });

/**
 * PostgreSQL-backed store for express-rate-limit (P1-11).
 *
 * Counters live in `rate_limit_buckets` so every API instance enforces the same
 * quota instead of each process keeping its own in-memory tally. The window is
 * fixed: the first hit in a window writes `window_start`, later hits only bump
 * `count` until the window expires.
 *
 * `increment` returns `{ totalHits, resetTime }` as express-rate-limit expects.
 */
export function createPostgresRateLimitStore({ bucket, windowMs, prefix = '' } = {}) {
  if (!bucket) throw new Error('createPostgresRateLimitStore requires a bucket name');
  const windowSeconds = Math.max(1, Math.ceil(Number(windowMs || 60_000) / 1000));

  async function readHit(key) {
    const prisma = await getPrismaClient();
    const ident = `${prefix}${key}`.slice(0, 255);
    const now = new Date();

    // Fast path: read the current window row.
    const existing = await prisma.rateLimitBucket.findUnique({
      where: { bucket_ident: { bucket, ident } },
    });

    if (existing && now.getTime() - existing.windowStart.getTime() < windowSeconds * 1000) {
      const [row] = await prisma.$queryRaw`
        UPDATE "rate_limit_buckets"
           SET "count" = "count" + 1, "updated_at" = NOW()
         WHERE "bucket" = ${bucket} AND "ident" = ${ident}
        RETURNING "count", "window_start"
      `;
      const totalHits = Number(row?.count ?? existing.count + 1);
      const windowStart = new Date(row?.window_start ?? existing.windowStart);
      return { totalHits, resetTime: new Date(windowStart.getTime() + windowSeconds * 1000) };
    }

    // New window: reset the counter.
    const [row] = await prisma.$queryRaw`
      INSERT INTO "rate_limit_buckets" ("bucket", "ident", "window_start", "count", "updated_at")
      VALUES (${bucket}, ${ident}, ${now}, 1, NOW())
      ON CONFLICT ("bucket", "ident") DO UPDATE
         SET "window_start" = EXCLUDED."window_start",
             "count" = 1,
             "updated_at" = NOW()
      RETURNING "count", "window_start"
    `;
    const windowStart = new Date(row?.window_start ?? now);
    return { totalHits: Number(row?.count ?? 1), resetTime: new Date(windowStart.getTime() + windowSeconds * 1000) };
  }

  return {
    /** express-rate-limit calls init() once when the limiter is constructed. */
    async init() {},
    /**
     * express-rate-limit v7/v8 calls `increment(key)` and expects a hit result.
     */
    async increment(key) {
      const hit = await readHit(key);
      return hit;
    },
    async decrement(key) {
      const prisma = await getPrismaClient();
      const ident = `${prefix}${key}`.slice(0, 255);
      await prisma.rateLimitBucket.updateMany({
        where: { bucket, ident },
        data: { count: { decrement: 1 } },
      });
    },
    async resetKey(key) {
      const prisma = await getPrismaClient();
      const ident = `${prefix}${key}`.slice(0, 255);
      await prisma.rateLimitBucket.deleteMany({ where: { bucket, ident } });
    },
    async resetAll() {
      const prisma = await getPrismaClient();
      await prisma.rateLimitBucket.deleteMany({ where: { bucket } });
    },
    /** Not tracked individually; express-rate-limit uses this for /reset. */
    async resetClient() {},
    async getClient() {
      return null;
    },
    /** Expired windows are pruned on a schedule, nothing to do per call. */
    async clearExpired() {},
    async shutdown() {},
    /** Drop rows whose window is long past (called opportunistically). */
    async cleanup() {
      if (!postgresEnabled()) return;
      try {
        const prisma = await getPrismaClient();
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await prisma.rateLimitBucket.deleteMany({ where: { windowStart: { lt: cutoff } } });
      } catch (error) {
        log.warn({ err: error }, 'Cannot prune rate limit buckets');
      }
    },
  };
}
