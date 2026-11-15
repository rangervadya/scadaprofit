// Optimistic concurrency for manual CAD (P2-6).
// PostgreSQL is the only store, so these tests pin the repository contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

test('manual-cad: PUT rejects a stale revision (409 REVISION_CONFLICT)', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/routes/manual-cad-routes.js'), 'utf8');
  const start = src.indexOf("router.put('/projects/:id'");
  assert.ok(start >= 0, 'missing PUT /projects/:id');
  const body = src.slice(start, start + 2000);
  assert.match(body, /If-Match/);
  assert.match(body, /REVISION_CONFLICT/);
  assert.match(body, /status\(409\)/);
  assert.match(body, /writeManualProjectIfRevision/);
});

test('manual-cad: writeManualProjectIfRevision delegates to the PG repository', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/server.js'), 'utf8');
  assert.match(src, /async function writeManualProjectIfRevision/);
  assert.match(src, /return saveManualProjectIfRevision\(project, expected\)/);
});

test('manual-cad: repo saveManualProjectIfRevision uses updateMany by revision', async () => {
  const repo = await readFile(join(ROOT, 'services/ollama/api/manual-cad-repo.js'), 'utf8');
  assert.match(repo, /export async function saveManualProjectIfRevision/);
  assert.match(repo, /revision: expected/);
  assert.match(repo, /result\.count === 1/);
});

test('manual-cad: JSON storage path removed, PostgreSQL required', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/server.js'), 'utf8');
  assert.doesNotMatch(src, /readManualProject\(id\)[\s\S]{0,400}return await readManualProject\(/);

  // The JSON fallback is gone from the workforce system too.
  const wf = await readFile(join(ROOT, 'services/ollama/api/workforce-system.js'), 'utf8');
  assert.match(wf, /requirePostgres\(\)/);
  assert.doesNotMatch(wf, /atomicJson/);
  assert.doesNotMatch(wf, /usePostgres/);

  const db = await readFile(join(ROOT, 'services/ollama/api/db.js'), 'utf8');
  assert.match(db, /export function requirePostgres/);
  assert.match(db, /POSTGRES_REQUIRED/);
});
