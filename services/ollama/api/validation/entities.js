import { z } from 'zod';

/**
 * Runtime contracts for rows read out of PostgreSQL (P1-14).
 *
 * Prisma already types the queries, but the repositories convert rows into the
 * plain objects the app works with. Validating at that boundary means a schema
 * drift (renamed column, unexpected null) surfaces as one clear error instead of
 * a confusing failure deep in a route handler.
 */

export const userSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  displayName: z.string(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  role: z.string().min(1),
  passwordHash: z.string().min(1),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const sessionSchema = z.object({
  tokenHash: z.string().min(1),
  userId: z.string().min(1),
  createdAt: z.string(),
  lastSeenAt: z.number(),
  expiresAt: z.number(),
});

export const manualProjectSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().default(''),
    manualEditRevision: z.number().default(0),
    updatedAt: z.string().optional(),
    createdAt: z.string().optional(),
    pipes: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Scheme metadata is an open object; only the container shape is enforced. */
export const schemeMetaSchema = z.record(z.unknown());

/**
 * Parse `value` with `schema`, logging a warning and returning `fallback` when
 * the row does not match. Repositories stay resilient: a single bad row must not
 * take down the whole list.
 */
export function parseOrDefault(schema, value, { label, fallback, log }) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  if (log) log.warn({ label, issues: result.error.issues.slice(0, 5) }, 'Unexpected database row shape');
  return fallback;
}
