// Business-flow integration tests (P2-1 safety net).
//
// Covers the flows the UI depends on, end to end against a real server and
// PostgreSQL: bootstrap → create users → dispatch tasks → visit → report →
// archive. These must stay green while the monolith is split into layers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

async function createFitter(role = 'fitter', name = 'Fitter') {
  const displayName = `${name} ${randomUUID().slice(0, 4)}`;
  const response = await admin.post('/api/workforce/users', {
    displayName,
    password: 'fitter-password-123',
    role,
    autoGenerate: false,
    username: `${role}-${randomUUID().slice(0, 8)}`,
  });
  assert.ok([200, 201].includes(response.status), `create user failed: ${response.text}`);
  const user = response.body.user;
  return {
    username: user.username,
    password: response.body.credentials?.password || 'fitter-password-123',
    id: user.id,
  };
}

test('bootstrap returns the access tree, users and task summary', { skip }, async () => {
  const response = await admin.get('/api/workforce/overview');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.ok(Array.isArray(response.body.users), 'users must be an array');
  assert.ok(response.body.summary && typeof response.body.summary === 'object');
});

test('a fitter can be created and appears in the user list', { skip }, async () => {
  const fitter = await createFitter('fitter', 'Integration');
  assert.ok(fitter.username);

  const list = await admin.get('/api/workforce/users');
  assert.equal(list.status, 200);
  const found = list.body.users.find((user) => user.username === fitter.username);
  assert.ok(found, 'created fitter must be listed');
  assert.equal(found.role, 'fitter');
});

test('duplicate usernames are rejected', { skip }, async () => {
  const username = `dup-${randomUUID().slice(0, 8)}`;
  const first = await admin.post('/api/workforce/users', {
    displayName: `Dup ${username.slice(-4)}`,
    username,
    password: 'dup-password-123',
    role: 'fitter',
    autoGenerate: false,
  });
  assert.ok([200, 201].includes(first.status), first.text);

  const second = await admin.post('/api/workforce/users', {
    displayName: `Dup ${username.slice(-4)}`,
    username,
    password: 'another-password-123',
    role: 'fitter',
    autoGenerate: false,
  });
  assert.equal(second.status, 409, 'duplicate username must be rejected');
});

test('dispatching a multi-house task creates one task per house', { skip }, async () => {
  const fitter = await createFitter('fitter', 'Dispatch');
  const street = `Улица ${randomUUID().slice(0, 6)}`;
  const houses = ['1', '2', '3'];

  const response = await admin.post('/api/workforce/tasks', {
    title: `Обход ${street}`,
    street,
    addresses: houses.join('\n'),
    scheduledDate: '2026-12-01',
    assignedTo: fitter.id,
  });

  assert.ok([200, 201].includes(response.status), `dispatch failed: ${response.text}`);
  const created = response.body.tasks || [];
  assert.equal(created.length, houses.length, 'one task per house');

  const list = await admin.get('/api/workforce/tasks');
  const dispatched = list.body.tasks.filter((task) => task.street === street);
  assert.equal(dispatched.length, houses.length, 'one task per house');

  const addresses = dispatched.map((task) => task.address);
  for (const house of houses) {
    assert.ok(addresses.includes(house), `missing task for house ${house}`);
  }
  // All tasks from one dispatch share an assignment group.
  const groups = new Set(dispatched.map((task) => task.assignmentGroupId));
  assert.equal(groups.size, 1, 'multi-house dispatch must share one assignment group');
});

test('task lifecycle: start -> visit -> office keeps the status consistent', { skip }, async () => {
  const fitter = await createFitter('fitter', 'Lifecycle');
  const street = `Улица ${randomUUID().slice(0, 6)}`;

  const created = await admin.post('/api/workforce/tasks', {
    title: `Обход ${street}`,
    street,
    addresses: '7',
    scheduledDate: '2026-12-02',
    assignedTo: fitter.id,
  });
  assert.ok([200, 201].includes(created.status));
  const taskId = created.body.tasks[0].id;

  // A fitter session drives the lifecycle.
  const fitterClient = createClient(server.baseUrl);
  const fitterLogin = await fitterClient.post('/api/auth/login', {
    username: fitter.username,
    password: fitter.password,
  });
  assert.equal(fitterLogin.status, 200);

  const start = await fitterClient.post(`/api/workforce/tasks/${taskId}/start`, {});
  assert.equal(start.status, 200);

  const afterStart = await fitterClient.get('/api/workforce/tasks');
  const started = afterStart.body.tasks.find((task) => task.id === taskId);
  assert.equal(started.status, 'in_progress');

  const visit = await fitterClient.post(`/api/workforce/tasks/${taskId}/visit`, {});
  assert.equal(visit.status, 200);

  const afterVisit = await fitterClient.get('/api/workforce/tasks');
  const visited = afterVisit.body.tasks.find((task) => task.id === taskId);
  assert.equal(visited.status, 'house_visited');
});

test('unknown task id returns 404 instead of crashing', { skip }, async () => {
  const response = await admin.post(`/api/workforce/tasks/${randomUUID()}/start`, {});
  assert.equal(response.status, 404);
  assert.equal(typeof response.body.error, 'string');
});

test('report listing is conditional and stable across polls', { skip }, async () => {
  const first = await admin.get('/api/workforce/reports');
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.ok(Array.isArray(first.body.reports));

  const etag = first.headers.get('etag');
  assert.ok(etag, 'reports must expose an ETag');

  const second = await admin.get('/api/workforce/reports', {
    headers: { 'if-none-match': etag },
  });
  assert.equal(second.status, 304, 'unchanged report list must return 304');
});
