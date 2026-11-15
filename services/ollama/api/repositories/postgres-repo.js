import { randomUUID } from 'node:crypto';
import { getPrismaClient, postgresEnabled } from './db.js';
import { parseOrDefault, sessionSchema, userSchema } from '../validation/entities.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'postgres' });

function userRow(user) {
  const createdAt = new Date(user.createdAt || Date.now());
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    role: user.role,
    passwordHash: user.passwordHash,
    active: user.active !== false,
    createdAt,
    updatedAt: new Date(user.updatedAt || user.createdAt || Date.now()),
  };
}

function sessionRow(session) {
  return {
    id: session.tokenHash,
    userId: session.userId,
    tokenHash: session.tokenHash,
    expiresAt: new Date(Number(session.expiresAt)),
    lastSeenAt: new Date(Number(session.lastSeenAt || Date.now())),
    createdAt: new Date(session.createdAt || Date.now()),
  };
}

export async function mirrorUser(user) {
  if (!postgresEnabled()) return false;
  try {
    const prisma = await getPrismaClient();
    const row = userRow(user);
    await prisma.user.upsert({
      where: { id: row.id },
      create: row,
      update: {
        username: row.username,
        displayName: row.displayName,
        firstName: row.firstName,
        lastName: row.lastName,
        role: row.role,
        passwordHash: row.passwordHash,
        active: row.active,
        updatedAt: row.updatedAt,
      },
    });
    return true;
  } catch (error) {
    log.warn({ err: error, userId: user.id }, 'Cannot mirror user into PostgreSQL');
    return false;
  }
}

export async function mirrorSession(session) {
  if (!postgresEnabled()) return false;
  try {
    const prisma = await getPrismaClient();
    const row = sessionRow(session);
    await prisma.session.upsert({
      where: { id: row.id },
      create: row,
      update: { expiresAt: row.expiresAt, lastSeenAt: row.lastSeenAt },
    });
    return true;
  } catch (error) {
    log.warn({ err: error, userId: session.userId }, 'Cannot mirror session into PostgreSQL');
    return false;
  }
}

export async function deleteSession(tokenHash) {
  if (!postgresEnabled() || !tokenHash) return false;
  try {
    const prisma = await getPrismaClient();
    await prisma.session.deleteMany({ where: { id: tokenHash } });
    return true;
  } catch (error) {
    log.warn({ err: error }, 'Cannot delete mirrored session');
    return false;
  }
}

export async function deleteUserSessions(userId) {
  if (!postgresEnabled()) return false;
  try {
    const prisma = await getPrismaClient();
    await prisma.session.deleteMany({ where: { userId } });
    return true;
  } catch (error) {
    log.warn({ err: error, userId }, 'Cannot delete mirrored user sessions');
    return false;
  }
}

/** Revoke every session (global logout). */
export async function deleteAllSessions() {
  if (!postgresEnabled()) return false;
  try {
    const prisma = await getPrismaClient();
    await prisma.session.deleteMany({});
    return true;
  } catch (error) {
    log.warn({ err: error }, 'Cannot delete all mirrored sessions');
    return false;
  }
}

export async function fetchUsers() {
  if (!postgresEnabled()) return [];
  const prisma = await getPrismaClient();
  const rows = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
  return rows
    .map((row) =>
      parseOrDefault(
        userSchema,
        {
          id: row.id,
          username: row.username,
          displayName: row.displayName,
          firstName: row.firstName || undefined,
          lastName: row.lastName || undefined,
          role: row.role,
          passwordHash: row.passwordHash,
          active: row.active,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
        { label: 'user', fallback: null, log },
      ),
    )
    .filter(Boolean);
}

export async function countUsers() {
  if (!postgresEnabled()) return 0;
  const prisma = await getPrismaClient();
  return prisma.user.count();
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export async function findIdempotency(endpoint, key) {
  if (!postgresEnabled() || !endpoint || !key) return null;
  try {
    const prisma = await getPrismaClient();
    const row = await prisma.idempotencyKey.findUnique({
      where: { key_endpoint: { key, endpoint } },
    });
    if (!row || row.expiresAt <= new Date()) return null;
    return { status: Number(row.status), response: row.response };
  } catch (error) {
    log.warn({ err: error, endpoint }, 'Cannot read idempotency key');
    return null;
  }
}

export async function saveIdempotency({ endpoint, key, userId = null, status, response }) {
  if (!postgresEnabled() || !endpoint || !key) return false;
  try {
    const prisma = await getPrismaClient();
    const row = {
      id: randomUUID(),
      key,
      endpoint,
      userId,
      status: String(status),
      response,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    };
    await prisma.idempotencyKey.upsert({
      where: { key_endpoint: { key, endpoint } },
      create: row,
      update: { status: row.status, response: row.response, expiresAt: row.expiresAt },
    });
    return true;
  } catch (error) {
    log.warn({ err: error, endpoint }, 'Cannot store idempotency key');
    return false;
  }
}

export async function fetchSessions() {
  if (!postgresEnabled()) return [];
  const prisma = await getPrismaClient();
  const rows = await prisma.session.findMany({ orderBy: { createdAt: 'asc' } });
  return rows
    .map((row) =>
      parseOrDefault(
        sessionSchema,
        {
          tokenHash: row.tokenHash,
          userId: row.userId,
          createdAt: row.createdAt.toISOString(),
          lastSeenAt: (row.lastSeenAt || row.createdAt).getTime(),
          expiresAt: row.expiresAt.getTime(),
        },
        { label: 'session', fallback: null, log },
      ),
    )
    .filter(Boolean);
}

/**
 * Update the activity timestamp of a session. Called on authenticated requests
 * so idle sessions can be expired (P1-2). Throttled by the caller to avoid a
 * write on every poll.
 */
export async function touchSession(tokenHash, when = Date.now()) {
  if (!postgresEnabled() || !tokenHash) return false;
  try {
    const prisma = await getPrismaClient();
    await prisma.session.updateMany({ where: { tokenHash }, data: { lastSeenAt: new Date(Number(when)) } });
    return true;
  } catch (error) {
    log.warn({ err: error }, 'Cannot touch session');
    return false;
  }
}
