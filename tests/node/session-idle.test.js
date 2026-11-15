// Session idle timeout and global revoke (P1-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const wfUrl = new URL('../../services/ollama/api/workforce-system.js', import.meta.url);
const repoUrl = new URL('../../services/ollama/api/postgres-repo.js', import.meta.url);
const schemaUrl = new URL('../../services/ollama/prisma/schema.prisma', import.meta.url);

test('idle: session freshness accounts for SESSION_IDLE_MS', async () => {
  const src = await readFile(wfUrl, 'utf8');
  assert.match(src, /SESSION_IDLE_MS/);
  assert.match(src, /SESSION_TOUCH_THROTTLE_MS/);
  // last_seen_at drives the idle check, not only the absolute expiry.
  assert.match(src, /SESSION_IDLE_MS > 0/);
  assert.match(src, /at - Number\(item\.lastSeenAt \|\| item\.createdAt \|\| 0\) > SESSION_IDLE_MS/);
});

test('idle: expired sessions are dropped on access, not only hourly', async () => {
  const src = await readFile(wfUrl, 'utf8');
  assert.match(src, /if \(!sessionIsLive\(known, now\)\)/);
  assert.match(src, /void deleteSession\(hash\)/);
});

test('idle: activity touch is throttled and persisted', async () => {
  const src = await readFile(wfUrl, 'utf8');
  assert.match(src, /touchSession\(hash, now\)/);
  const repo = await readFile(repoUrl, 'utf8');
  assert.match(repo, /export async function touchSession/);
  assert.match(repo, /lastSeenAt: new Date\(Number\(when\)\)/);
});

test('revoke: global revoke-all endpoint exists', async () => {
  const src = await readFile(wfUrl, 'utf8');
  assert.match(src, /routes\.post\('\/api\/workforce\/admin\/revoke-all-sessions'/);
  assert.match(src, /deleteAllSessions\(\)/);
  const repo = await readFile(repoUrl, 'utf8');
  assert.match(repo, /export async function deleteAllSessions/);
  assert.match(repo, /prisma\.session\.deleteMany\(\{\}\)/);
});

test('schema: Session has lastSeenAt with index', async () => {
  const schema = await readFile(schemaUrl, 'utf8');
  assert.match(schema, /lastSeenAt\s+DateTime\s+@default\(now\(\)\)\s+@map\("last_seen_at"\)/);
  assert.match(schema, /@@index\(\[lastSeenAt\]\)/);
});
