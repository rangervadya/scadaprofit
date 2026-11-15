// End-to-end API tests against a real server and PostgreSQL (P2-1 safety net).
//
// These are the tests that must stay green while the monoliths are split into
// layers: they assert observable HTTP behaviour, not file contents.
//
// Run with:
//   INTEGRATION=1 INTEGRATION_DATABASE_URL=... node --test tests/node/integration/api.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { integrationEnabled, startServer, createClient, ensureAdmin } from '../helpers/integration-harness.js';

const skip = integrationEnabled ? false : 'set INTEGRATION=1 and INTEGRATION_DATABASE_URL to run';

let server;
let admin;

before(async () => {
  if (!integrationEnabled) return;
  server = await startServer();
  admin = createClient(server.baseUrl);
  await ensureAdmin(admin);
});
after(async () => {
  if (server) await server.close();
});

test('health and readiness report their real state', { skip }, async () => {
  const client = createClient(server.baseUrl);

  const health = await client.get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(typeof health.body.version, 'string');

  const ready = await client.get('/api/readyz');
  assert.ok([200, 503].includes(ready.status));
  assert.equal(typeof ready.body.ok, 'boolean');
  if (ready.status === 503) {
    assert.equal(ready.body.ok, false);
    assert.ok(ready.body.checks, 'readiness must explain what is missing');
  }
});

test('protected endpoints reject an anonymous request', { skip }, async () => {
  const client = createClient(server.baseUrl);

  for (const pathname of ['/api/workforce/tasks', '/api/workforce/reports', '/api/library', '/api/auth/me']) {
    const response = await client.get(pathname);
    assert.equal(response.status, 401, `${pathname} must require a session`);
  }
});

test('login issues a session and /api/auth/me returns the role', { skip }, async () => {
  const client = createClient(server.baseUrl);
  const username = process.env.INTEGRATION_ADMIN_USER || 'integration-admin';
  const password = process.env.INTEGRATION_ADMIN_PASSWORD || 'integration-password-123';

  const anon = await client.get('/api/auth/me');
  assert.equal(anon.status, 401);

  const login = await client.post('/api/auth/login', { username, password });
  assert.equal(login.status, 200);
  assert.equal(login.body.ok, true);
  assert.equal(login.body.user.role, 'developer');

  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, username);
});

test('wrong password is rejected and does not create a session', { skip }, async () => {
  const client = createClient(server.baseUrl);

  const response = await client.post('/api/auth/login', {
    username: process.env.INTEGRATION_ADMIN_USER || 'integration-admin',
    password: 'definitely-wrong',
  });
  assert.equal(response.status, 401);

  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 401);
});

test('logout invalidates the session', { skip }, async () => {
  const client = createClient(server.baseUrl);
  await client.post('/api/auth/login', {
    username: process.env.INTEGRATION_ADMIN_USER || 'integration-admin',
    password: process.env.INTEGRATION_ADMIN_PASSWORD || 'integration-password-123',
  });
  assert.equal((await client.get('/api/auth/me')).status, 200);

  const logout = await client.post('/api/auth/logout', {});
  assert.equal(logout.status, 200);

  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 401);
});
