import { getPrismaClient, postgresEnabled } from './db.js';
import { logger } from './logger.js';

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
      update: { expiresAt: row.expiresAt },
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
  if (!postgresEnabled() || !userId) return false;
  try {
    const prisma = await getPrismaClient();
    await prisma.session.deleteMany({ where: { userId } });
    return true;
  } catch (error) {
    log.warn({ err: error, userId }, 'Cannot delete mirrored user sessions');
    return false;
  }
}

export async function fetchUsers() {
  if (!postgresEnabled()) return [];
  const prisma = await getPrismaClient();
  const rows = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map((row) => ({
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
  }));
}

export async function countUsers() {
  if (!postgresEnabled()) return 0;
  const prisma = await getPrismaClient();
  return prisma.user.count();
}
