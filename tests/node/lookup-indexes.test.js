// Lookup indexes replace linear scans (P2-5).
//
// Serializing a list used to be O(n^2): every task/report walked all users and
// every task. These tests pin the index-based serializers so a regression back to
// per-item scanning is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

const src = await readFile(join(ROOT, 'services/ollama/api/workforce-system.js'), 'utf8');
const server = await readFile(join(ROOT, 'services/ollama/api/server.js'), 'utf8');

test('p2-5: serializers use lookup maps instead of per-item scans', () => {
  assert.match(src, /function buildLookups\(\)/);
  assert.match(src, /const usersById = new Map\(\)/);
  assert.match(src, /const reportsByTask = new Map\(\)/);
  assert.match(src, /const defectsByTask = new Map\(\)/);

  const taskBody = src.slice(src.indexOf('function taskForClient'), src.indexOf('function reportForClient'));
  assert.doesNotMatch(taskBody, /users\.find\(/);
  assert.doesNotMatch(taskBody, /workspace\.reports\.filter\(/);
  assert.doesNotMatch(taskBody, /workspace\.defectReports\.filter\(/);
  assert.match(taskBody, /usersById\.get\(/);
  assert.match(taskBody, /reportsByTask\.get\(/);
});

test('p2-5: report serializers use the task and user maps', () => {
  for (const fn of ['function reportForClient', 'function defectReportForClient']) {
    const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 1200);
    assert.doesNotMatch(body, /workspace\.tasks\.find\(/, `${fn} still scans tasks`);
    assert.doesNotMatch(body, /users\.find\(/, `${fn} still scans users`);
    assert.match(body, /tasksById\.get\(/);
    assert.match(body, /usersById\.get\(/);
  }
});

test('p2-5: lookups are invalidated on write', () => {
  assert.match(src, /function invalidateLookups\(\)/);
  assert.match(src, /invalidateLookups\(\);/);
  // Both persistence helpers invalidate, so mutations cannot serve stale maps.
  const saveUsers = src.slice(src.indexOf('const saveUsers = async'), src.indexOf('const saveUsers = async') + 200);
  assert.match(saveUsers, /invalidateLookups\(\)/);
  const saveWs = src.slice(
    src.indexOf('const saveWorkspace = () =>'),
    src.indexOf('const saveWorkspace = () =>') + 400,
  );
  assert.match(saveWs, /invalidateLookups\(\)/);
});

test('p2-5: findScheme uses an index with a scan fallback', () => {
  assert.match(server, /function buildSchemeIndex\(library\)/);
  assert.match(server, /function getSchemeIndex\(library\)/);
  const body = server.slice(server.indexOf('function findScheme(library, jobId)'));
  assert.match(body, /getSchemeIndex\(library\)\.get\(jobId\)/);
});

test('p2-5: no linear scan remains in the list serializers', () => {
  // A regression would reintroduce these patterns in the serializers.
  const serializers = ['function taskForClient', 'function reportForClient', 'function defectReportForClient'];
  for (const fn of serializers) {
    const start = src.indexOf(fn);
    assert.ok(start >= 0, `missing ${fn}`);
    const body = src.slice(start, start + 1400);
    assert.doesNotMatch(body, /\busers\.find\(/, `${fn} scans users`);
  }
});
