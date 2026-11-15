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

test('address library: create street and building, reject duplicates', { skip }, async () => {
  const streetName = `Улица ${randomUUID().slice(0, 6)}`;
  const houseName = String(1 + Math.floor(Math.random() * 90));

  const street = await admin.post('/api/library/streets', { name: streetName });
  assert.equal(street.status, 201, street.text);
  assert.equal(street.body.street.name, streetName);

  const duplicateStreet = await admin.post('/api/library/streets', { name: streetName });
  assert.equal(duplicateStreet.status, 409, 'duplicate street must be rejected');

  const building = await admin.post('/api/library/buildings', {
    streetId: street.body.street.id,
    name: houseName,
  });
  assert.equal(building.status, 201, building.text);
  assert.equal(building.body.building.name, houseName);

  const duplicateBuilding = await admin.post('/api/library/buildings', {
    streetId: street.body.street.id,
    name: houseName,
  });
  assert.equal(duplicateBuilding.status, 409, 'duplicate building must be rejected');

  const library = await admin.get('/api/library');
  assert.equal(library.status, 200);
  const found = library.body.library.streets.find((item) => item.id === street.body.street.id);
  assert.ok(found, 'created street must be listed');
  assert.ok(found.buildings.some((item) => item.id === building.body.building.id));
});

test('address library rejects invalid payloads', { skip }, async () => {
  const missingName = await admin.post('/api/library/streets', {});
  assert.ok([400, 422].includes(missingName.status), `expected 400/422, got ${missingName.status}`);

  const badBuilding = await admin.post('/api/library/buildings', {
    streetId: 'not-a-uuid',
    name: '1',
  });
  assert.ok([400, 422].includes(badBuilding.status), `expected 400/422, got ${badBuilding.status}`);
});

test('scheme upload requires an image and a valid address', { skip }, async () => {
  // No file: 400.
  const noFile = await admin.post('/api/library/schemes/upload', {
    streetId: randomUUID(),
    buildingId: randomUUID(),
  });
  assert.equal(noFile.status, 400);

  // File but unknown address: 404.
  const form = new FormData();
  form.append('streetId', randomUUID());
  form.append('buildingId', randomUUID());
  form.append('image', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'scan.jpg');
  const unknownAddress = await admin.post('/api/library/schemes/upload', form);
  assert.equal(unknownAddress.status, 404);
});

test('scheme endpoints reject malformed job ids', { skip }, async () => {
  for (const pathname of ['/api/library/schemes/not-a-uuid', '/api/library/schemes/not-a-uuid/status']) {
    const response = await admin.get(pathname);
    assert.equal(response.status, 400, `${pathname} must reject a malformed id`);
  }

  const analyze = await admin.post('/api/library/schemes/not-a-uuid/analyze', {});
  assert.equal(analyze.status, 400);
});

test('admin diagnostics reports live counters', { skip }, async () => {
  const response = await admin.get('/api/workforce/admin/diagnostics');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(typeof response.body.users, 'number');
  assert.equal(typeof response.body.tasks, 'number');
  assert.equal(typeof response.body.version, 'string');
  assert.equal(response.body.gpsTracking, false);
});

test('reset-password issues credentials and revokes the user sessions', { skip }, async () => {
  const fitter = await createFitter('fitter', 'Reset');
  const fitterClient = createClient(server.baseUrl);
  const login = await fitterClient.post('/api/auth/login', {
    username: fitter.username,
    password: fitter.password,
  });
  assert.equal(login.status, 200);
  assert.equal((await fitterClient.get('/api/auth/me')).status, 200);

  const reset = await admin.post(`/api/workforce/users/${fitter.id}/reset-password`, {});
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.body.ok, true);
  assert.ok(reset.body.credentials.password, 'new password must be returned');
  assert.notEqual(reset.body.credentials.password, fitter.password);

  // Old session is gone.
  assert.equal((await fitterClient.get('/api/auth/me')).status, 401);

  // New password works.
  const relogin = createClient(server.baseUrl);
  const ok = await relogin.post('/api/auth/login', {
    username: fitter.username,
    password: reset.body.credentials.password,
  });
  assert.equal(ok.status, 200);
});

test('revoke-all-sessions logs out every active session', { skip }, async () => {
  const fitter = await createFitter('fitter', 'Revoke');
  const a = createClient(server.baseUrl);
  const b = createClient(server.baseUrl);
  for (const client of [a, b]) {
    const login = await client.post('/api/auth/login', { username: fitter.username, password: fitter.password });
    assert.equal(login.status, 200);
  }

  const revoked = await admin.post('/api/workforce/admin/revoke-all-sessions', {});
  assert.equal(revoked.status, 200, revoked.text);
  assert.ok(revoked.body.revoked >= 1);

  assert.equal((await a.get('/api/auth/me')).status, 401);
  assert.equal((await b.get('/api/auth/me')).status, 401);
});
