// Write amplification guard (P2-4).
//
// The workspace is persisted with a transaction across the normalized tables, so
// a GET that only reads must not write. These tests pin the two mechanisms that
// keep polling cheap: skipping the save on read-only endpoints, and skipping the
// save when the snapshot is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

function routeBody(src, route) {
  const start = src.indexOf(route);
  assert.ok(start >= 0, `route not found: ${route}`);
  const end = src.indexOf('\n  });', start);
  assert.ok(end > start, `route end not found: ${route}`);
  return src.slice(start, end);
}

test('p2-4: GET /api/workforce/reports only writes when a status moved', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/routes/workforce-inbox-routes.js'), 'utf8');
  const body = routeBody(src, "router.get('/reports'");
  assert.match(body, /if \(await refreshSchemeState\(report\)\) changed = true;/);
  // The save must be conditional: exactly one saveWorkspace call, guarded.
  const saves = body.match(/saveWorkspace\(\)/g) || [];
  assert.equal(saves.length, 1, 'expected exactly one saveWorkspace call in the handler');
  assert.match(body, /if \(changed\) await saveWorkspace\(\);/);
});

test('p2-4: refreshSchemeState reports whether anything changed', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/routes/workforce-inbox-routes.js'), 'utf8');
  assert.match(src, /const before = `\$\{report\.schemeStatus\}/);
  assert.match(src, /return before !== after;/);
});

test('p2-4: saveWorkspace skips writes when the snapshot is unchanged', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/services/workforce-system.js'), 'utf8');
  assert.match(src, /let lastWorkspaceSnapshot = null;/);
  assert.match(src, /const snapshot = JSON\.stringify\(workspace\);/);
  assert.match(src, /if \(snapshot === lastWorkspaceSnapshot\) return Promise\.resolve\(true\);/);
  assert.match(src, /lastWorkspaceSnapshot = snapshot;/);
});

test('p2-4: legacy JSONB write-through is gone from the repositories', async () => {
  const ws = await readFile(join(ROOT, 'services/ollama/api/repositories/workforce-workspace-repo.js'), 'utf8');
  const lib = await readFile(join(ROOT, 'services/ollama/api/repositories/address-library-repo.js'), 'utf8');
  assert.doesNotMatch(ws, /tx\.workforceWorkspace\.upsert/);
  assert.doesNotMatch(lib, /tx\.addressLibrary\.upsert/);
  // The legacy models are no longer in the Prisma schema.
  const schema = await readFile(join(ROOT, 'services/ollama/prisma/schema.prisma'), 'utf8');
  assert.doesNotMatch(schema, /model WorkforceWorkspace/);
  assert.doesNotMatch(schema, /model AddressLibrary/);
});
