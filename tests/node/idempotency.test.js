// Проверяет, что идемпотентность подключена к /api/analyze и /api/workforce/tasks.
// Статическая проверка по исходникам — не требует запущенного сервера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const SERVER = readFileSync(join(ROOT, 'services/ollama/api/server.js'), 'utf8');
const WORKFORCE = readFileSync(join(ROOT, 'services/ollama/api/workforce-system.js'), 'utf8');
const REPO = readFileSync(join(ROOT, 'services/ollama/api/postgres-repo.js'), 'utf8');

test('idempotency: postgres-repo экспортирует find/save', () => {
  assert.match(REPO, /export async function findIdempotency/);
  assert.match(REPO, /export async function saveIdempotency/);
  assert.match(REPO, /idempotencyKey\.upsert/);
});

test('idempotency: /api/analyze читает и пишет ключ', () => {
  // handler начинается с app.post('/api/analyze'
  const start = SERVER.indexOf("app.post('/api/analyze'");
  assert.ok(start >= 0, 'нет /api/analyze');
  const body = SERVER.slice(start, start + 12000);
  assert.match(body, /findIdempotency\(analyzeEndpoint/);
  assert.match(body, /saveIdempotency\(\{[\s\S]*endpoint: analyzeEndpoint/);
});

test('idempotency: /api/workforce/tasks читает и пишет ключ', () => {
  const start = WORKFORCE.indexOf("routes.post('/api/workforce/tasks'");
  assert.ok(start >= 0, 'нет POST /api/workforce/tasks');
  const body = WORKFORCE.slice(start, start + 3000);
  assert.match(body, /findIdempotency\('POST \/api\/workforce\/tasks'/);
  assert.match(body, /saveIdempotency\(\{[\s\S]*endpoint: 'POST \/api\/workforce\/tasks'/);
});
