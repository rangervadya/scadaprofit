// Typed runtime layer for database rows (P1-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressLibrarySchema,
  manualProjectSchema,
  parseOrDefault,
  sessionSchema,
  userSchema,
  workspaceSchema,
} from '../../services/ollama/api/entities.js';

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

test('workspace: arrays default and unknown keys pass through', () => {
  const parsed = parseOrDefault(
    workspaceSchema,
    { tasks: [{ id: 1 }], extra: true },
    { label: 'ws', fallback: null, log },
  );
  assert.deepEqual(parsed.tasks, [{ id: 1 }]);
  assert.deepEqual(parsed.reports, []);
  assert.equal(parsed.extra, true);
});

test('workspace: non-object falls back to null', () => {
  assert.equal(parseOrDefault(workspaceSchema, 'nope', { label: 'ws', fallback: null, log }), null);
  assert.equal(parseOrDefault(workspaceSchema, null, { label: 'ws', fallback: null, log }), null);
});

test('address library: missing arrays default to empty', () => {
  const parsed = parseOrDefault(addressLibrarySchema, { streets: [] }, { label: 'lib', fallback: null, log });
  assert.deepEqual(parsed.buildings, []);
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
  const pg = await readFile(new URL('../../services/ollama/api/postgres-repo.js', import.meta.url), 'utf8');
  assert.match(pg, /parseOrDefault\(\s*userSchema/);
  assert.match(pg, /parseOrDefault\(\s*sessionSchema/);

  const ws = await readFile(new URL('../../services/ollama/api/workforce-workspace-repo.js', import.meta.url), 'utf8');
  assert.match(ws, /parseOrDefault\(workspaceSchema/);

  const lib = await readFile(new URL('../../services/ollama/api/address-library-repo.js', import.meta.url), 'utf8');
  assert.match(lib, /parseOrDefault\(addressLibrarySchema/);

  const cad = await readFile(new URL('../../services/ollama/api/manual-cad-repo.js', import.meta.url), 'utf8');
  assert.match(cad, /parseOrDefault\(manualProjectSchema/);
});
