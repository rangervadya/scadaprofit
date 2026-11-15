// Backend contracts that used to be asserted through the legacy UI fixtures.
//
// The legacy multi-page UI (tests/fixtures/legacy-frontend/) was replaced by the
// React SPA and is no longer served, so its HTML/JS assertions were removed
// (P2-11). The backend rules they covered are kept here until they are covered
// by behavioural API tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

const read = (relative) => readFile(join(ROOT, relative), 'utf8');

test('multi-house dispatch deduplicates and caps the house list', async () => {
  const src = await read('services/ollama/api/workforce-core.js');
  const body = src.slice(src.indexOf('export function parseHouseAddresses'));
  assert.match(body, /new Set\(\)/);
  assert.match(body, /if \(unique\.length > 100\)/);
});

test('folder transfer is atomic and rejects per-item conclusion transfers', async () => {
  const core = await read('services/ollama/api/workforce-core.js');
  const src = await read('services/ollama/api/workforce-system.js');
  assert.match(core, /export function evaluateAddressFolder/);
  assert.match(src, /routes\.post\('\/api\/workforce\/tasks\/:taskId\/conclusion'/);
  assert.match(src, /report\.conclusionFolderId = task\.id/);
});

test('folder transfer requires seen and accepted materials', async () => {
  const src = await read('services/ollama/api/workforce-core.js');
  const start = src.indexOf('export function evaluateAddressFolder');
  assert.ok(start >= 0);
  const body = src.slice(start, start + 2000);
  assert.match(body, /seen/);
  assert.match(body, /accepted/);
});

test('password reset issues a one-time password and revokes sessions', async () => {
  const src = await read('services/ollama/api/workforce-system.js');
  const start = src.indexOf("routes.post('/api/workforce/users/:id/reset-password'");
  assert.ok(start >= 0);
  const body = src.slice(start, start + 900);
  assert.match(body, /randomBytes\(15\)/);
  assert.match(body, /deleteUserSessions\(user\.id\)/);
  assert.match(body, /requireRoles\(req, res, \['supervisor', 'developer'\]\)/);
});

test('receiver role guards stay on the report and defect routes', async () => {
  const src = await read('services/ollama/api/workforce-system.js');
  assert.match(src, /requireRoles\(req, res, \['receiver', 'supervisor', 'developer'\]\)/);
});

test('defect reports are stored separately from generated documents', async () => {
  const src = await read('services/ollama/api/workforce-system.js');
  assert.match(src, /defectReports/);
  assert.match(src, /workspace\.defectReports/);
});
