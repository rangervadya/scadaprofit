// Typed runtime layer for database rows (P1-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  manualProjectSchema,
  parseOrDefault,
  sessionSchema,
  userSchema,
} from '../../services/ollama/api/validation/entities.js';

const warnings = [];
const log = { warn: (obj, msg) => warnings.push({ obj, msg }) };

test('user: valid row parses, bad row falls back', () => {
  const good = parseOrDefault(
    userSchema,
    {
      id: 'u1',
      username: 'a',
      displayName: 'A',
      role: 'fitter',
      passwordHash: 'h',
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    { label: 'user', fallback: null, log },
  );
  assert.equal(good.id, 'u1');

  const bad = parseOrDefault(userSchema, { id: 'u2' }, { label: 'user', fallback: null, log });
  assert.equal(bad, null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].msg, 'Unexpected database row shape');
});

test('session: numeric timestamps are preserved', () => {
  const row = parseOrDefault(
    sessionSchema,
    { tokenHash: 't', userId: 'u', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: 10, expiresAt: 20 },
    { label: 'session', fallback: null, log },
  );
  assert.equal(row.lastSeenAt, 10);
  assert.equal(row.expiresAt, 20);
});

test('manual project: revision defaults and extra fields survive', () => {
  const parsed = parseOrDefault(
    manualProjectSchema,
    { id: 'p1', title: 'T', pipes: [], custom: 1 },
    { label: 'p', fallback: null, log },
  );
  assert.equal(parsed.manualEditRevision, 0);
  assert.equal(parsed.custom, 1);
});

test('repos validate rows on read', async () => {
  const { readFile } = await import('node:fs/promises');
  const pg = await readFile(
    new URL('../../services/ollama/api/repositories/postgres-repo.js', import.meta.url),
    'utf8',
  );
  assert.match(pg, /parseOrDefault\(\s*userSchema/);
  assert.match(pg, /parseOrDefault\(\s*sessionSchema/);

  const lib = await readFile(
    new URL('../../services/ollama/api/repositories/address-library-repo.js', import.meta.url),
    'utf8',
  );
  assert.match(lib, /prisma\.addressStreet\.findMany/);

  const cad = await readFile(
    new URL('../../services/ollama/api/repositories/manual-cad-repo.js', import.meta.url),
    'utf8',
  );
  assert.match(cad, /parseOrDefault\(manualProjectSchema/);
});

test('normalized repos read from tables instead of the JSONB singleton', async () => {
  const { readFile } = await import('node:fs/promises');
  const ws = await readFile(
    new URL('../../services/ollama/api/repositories/workforce-workspace-repo.js', import.meta.url),
    'utf8',
  );
  assert.match(ws, /prisma\.workforceTask\.findMany/);
  assert.doesNotMatch(ws, /parseOrDefault\(workspaceSchema/);
});
