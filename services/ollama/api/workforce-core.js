import path from 'node:path';
import { randomUUID, randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, copyFile, chmod, rename, rm } from 'node:fs/promises';

/**
 * Pure workforce helpers (P2-1): roles, names, text, password hashing, cookies.
 *
 * Moved from workforce-system.js verbatim — the password format, cookie flags and
 * upload staging semantics must not change, or existing accounts and reports break.
 */

const scrypt = promisify(scryptCallback);

export const SESSION_COOKIE = 'profit_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Idle timeout: a session dies after this period without any request (P1-2).
export const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MS || 12 * 60 * 60 * 1000);
// Do not write last_seen_at on every request; one write per minute is enough.
export const SESSION_TOUCH_THROTTLE_MS = 60 * 1000;

export const ROLE_NAMES = {
  fitter: 'Слесарь',
  receiver: 'Приёмщик',
  supervisor: 'Руководитель',
  developer: 'Разработчик',
};
export const VALID_ROLES = new Set(Object.keys(ROLE_NAMES));

export function cleanText(value, max = 240) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function splitHumanName(value) {
  const parts = cleanText(value, 100).split(' ').filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

export function publicUser(user) {
  if (!user) return null;
  const parsedName = splitHumanName(user.displayName);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    firstName: user.firstName || parsedName.firstName,
    lastName: user.lastName || parsedName.lastName,
    role: user.role,
    roleName: ROLE_NAMES[user.role] || user.role,
    active: user.active !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt || null,
  };
}

export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function cookieValue(header, name) {
  const prefix = `${name}=`;
  for (const part of String(header || '').split(';')) {
    const item = part.trim();
    if (item.startsWith(prefix)) {
      try {
        return decodeURIComponent(item.slice(prefix.length));
      } catch {
        return '';
      }
    }
  }
  return '';
}

export function setSessionCookie(res, token, secure) {
  const flags = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

export function clearSessionCookie(res, secure) {
  const flags = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(String(password), salt, 64);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !/^[a-f0-9]{128}$/i.test(expectedHex || '')) return false;
  const actual = Buffer.from(await scrypt(String(password), salt, 64));
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Persist a Multer temporary upload in the private data directory. Multer's
 * default temp directory may be mounted on a different filesystem from the
 * persistent /data volume, so renaming the upload directly can fail with
 * EXDEV. Copy to a unique staging file beside the destination, then rename
 * within that filesystem (atomic there). The source is removed only after
 * the destination has been committed.
 */
export async function persistUploadedFile(sourcePath, destinationPath) {
  const destinationDir = path.dirname(destinationPath);
  const stagingPath = path.join(destinationDir, `.${path.basename(destinationPath)}.${randomUUID()}.uploading`);
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  try {
    await copyFile(sourcePath, stagingPath);
    await chmod(stagingPath, 0o600);
    // Both paths are on the destination filesystem, avoiding cross-device rename.
    await rename(stagingPath, destinationPath);
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => {});
    throw error;
  }
  // A cleanup failure must not turn a successfully saved report into an error.
  await rm(sourcePath, { force: true }).catch(() => {});
  return destinationPath;
}

// The same credential check is used by the login endpoint and tested directly.
export async function authenticateCredentials(users, username, password) {
  const normalizedUsername = cleanText(username, 48).toLowerCase();
  const user = (Array.isArray(users) ? users : []).find(
    (item) => String(item?.username || '').toLowerCase() === normalizedUsername && item.active !== false,
  );
  if (!user || !(await verifyPassword(String(password || ''), user.passwordHash))) return null;
  return user;
}
export function parseHouseAddresses(value, fallbackAddress = '') {
  let candidates = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : String(value).split(/[\r\n;]+/);
  if (!candidates.some((item) => String(item ?? '').trim()) && fallbackAddress) candidates = [fallbackAddress];

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const address = cleanText(candidate, 120);
    if (!address) continue;
    const key = address.toLocaleLowerCase('ru-RU');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(address);
    if (unique.length > 100) throw new RangeError('За одно назначение можно добавить не более 100 домов.');
  }
  return unique;
}

/** Evaluate whether every live item in one address folder is ready for a single conclusion transfer. */
export function evaluateAddressFolder({ schemes = [], defects = [], userId = null } = {}) {
  const liveSchemes = (Array.isArray(schemes) ? schemes : []).filter((item) => item?.status !== 'superseded');
  const liveDefects = (Array.isArray(defects) ? defects : []).filter((item) => item?.status !== 'superseded');
  const items = [...liveSchemes, ...liveDefects];
  const allAccepted = items.length > 0 && items.every((item) => item.status === 'accepted');
  const schemesReady = liveSchemes.every(
    (item) =>
      item.schemeJobId &&
      (item.schemeStatus === 'completed' || (item.schemeStatus === 'failed' && item.schemePartialGraphReady === true)),
  );
  const photosReady = liveDefects.every((item) => Array.isArray(item.photos) && item.photos.length > 0);
  const unseenCount = userId
    ? items.filter((item) => !(Array.isArray(item.seenBy) && item.seenBy.includes(userId))).length
    : 0;
  return {
    items,
    schemes: liveSchemes,
    defects: liveDefects,
    allAccepted,
    schemesReady,
    photosReady,
    unseenCount,
    ready: allAccepted && schemesReady && photosReady && unseenCount === 0,
  };
}
