// Shared PostgreSQL rate-limit store (P1-11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

test('ratelimit store: implements the express-rate-limit store contract', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/rate-limit-store.js'), 'utf8');
  for (const method of ['init', 'increment', 'decrement', 'resetKey', 'resetAll', 'shutdown']) {
    assert.match(src, new RegExp(`async ${method}\\(`), `missing ${method}`);
  }
  // increment must return { totalHits, resetTime } for express-rate-limit.
  assert.match(src, /totalHits/);
  assert.match(src, /resetTime/);
});

test('ratelimit store: counters are keyed by bucket and ident', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/rate-limit-store.js'), 'utf8');
  assert.match(src, /rate_limit_buckets/);
  assert.match(src, /bucket_ident/);
  assert.match(src, /ON CONFLICT \("bucket", "ident"\) DO UPDATE/);
});

test('ratelimit store: wired into server limiters', async () => {
  const src = await readFile(join(ROOT, 'services/ollama/api/server.js'), 'utf8');
  assert.match(src, /createPostgresRateLimitStore/);
  assert.match(src, /bucket: 'auth'/);
  assert.match(src, /bucket: 'heavy'/);
  assert.match(src, /bucket: 'upload'/);
  assert.match(src, /store: authStore/);
  assert.match(src, /store: heavyStore/);
  assert.match(src, /store: uploadStore/);
});

test('ratelimit store: migration and schema exist', async () => {
  const schema = await readFile(join(ROOT, 'services/ollama/prisma/schema.prisma'), 'utf8');
  assert.match(schema, /model RateLimitBucket/);
  assert.match(schema, /@@map\("rate_limit_buckets"\)/);
});
