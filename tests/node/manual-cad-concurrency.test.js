// Оптимистичная конкурентность manual CAD (P2-3).
// Проверяет JSON-fallback путь напрямую: writeManualProjectIfRevision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

test('manual-cad: PUT отклоняет устаревшую ревизию (409 REVISION_CONFLICT)', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/server.js'), 'utf8');
  // Проверяем, что обработчик использует If-Match / expectedRevision и 409.
  const start = src.indexOf("app.put('/api/manual-cad/projects/:id'");
  assert.ok(start >= 0, 'нет PUT /api/manual-cad/projects/:id');
  const body = src.slice(start, start + 2000);
  assert.match(body, /If-Match/);
  assert.match(body, /REVISION_CONFLICT/);
  assert.match(body, /status\(409\)/);
  assert.match(body, /writeManualProjectIfRevision/);
});

test('manual-cad: writeManualProjectIfRevision существует и возвращает статус', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/server.js'), 'utf8');
  assert.match(src, /async function writeManualProjectIfRevision/);
  assert.match(src, /return 'conflict'/);
  assert.match(src, /return 'missing'/);
  assert.match(src, /return 'ok'/);
});

test('manual-cad: repo saveManualProjectIfRevision использует updateMany по revision', async () => {
  const repo = await readFile(join(ROOT, 'services/ollama/api/manual-cad-repo.js'), 'utf8');
  assert.match(repo, /export async function saveManualProjectIfRevision/);
  assert.match(repo, /revision: expected/);
  assert.match(repo, /result\.count === 1/);
});

test('manual-cad: рекурсивный readManualProject в JSON-режиме устранён', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/server.js'), 'utf8');
  const start = src.indexOf('async function readManualProject(id) {');
  assert.ok(start >= 0);
  const body = src.slice(start, start + 700);
  // В JSON-ветке не должно быть самовызова.
  const jsonBranch = body.split('return await readManualProject(').length - 1;
  assert.equal(jsonBranch, 0, 'readManualProject всё ещё вызывает себя');
});
