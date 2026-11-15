/**
 * Shared harness for integration tests (P2-1 safety net).
 *
 * Boots the real API against a dedicated PostgreSQL database and returns a small
 * fetch wrapper plus lifecycle helpers. Unlike the source-string tests, these
 * exercise the running server end to end: real routing, real Prisma queries, real
 * session cookies.
 *
 * The database is expected to be migrated already (`npm run db:deploy:test`).
 * `INTEGRATION=1` opts in, so `npm test` stays fast and hermetic by default.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/node/helpers -> repo root
const ROOT = path.resolve(__dirname, '../../..');
const API_DIR = path.join(ROOT, 'services/ollama/api');

export const integrationEnabled = process.env.INTEGRATION === '1';

export function testDbUrl() {
  const url = process.env.INTEGRATION_DATABASE_URL;
  if (!url) {
    throw new Error(
      'INTEGRATION_DATABASE_URL is not set. Create a database and run: npm --prefix services/ollama run db:deploy:test',
    );
  }
  return url;
}

async function waitForHealth(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`server did not become healthy: ${lastError?.message || 'timeout'}`);
}

/**
 * Start the API on an ephemeral port.
 * Returns `{ baseUrl, close, logs }` where `logs()` yields captured stdout+stderr.
 */
export async function startServer({ env = {} } = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const chunks = [];

  const child = spawn(process.execPath, [path.join(API_DIR, 'server.js')], {
    cwd: API_DIR,
    env: {
      ...process.env,
      AUTH_BACKEND: 'postgres',
      DATABASE_URL: testDbUrl(),
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'error',
      DATA_DIR: path.join('/tmp', `scadaprofit-itest-${randomBytes(6).toString('hex')}`),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\n--- server output ---\n${chunks.join('')}`);
  }

  return {
    baseUrl,
    logs: () => chunks.join(''),
    exitInfo: () => exited,
    async close() {
      if (exited) return;
      child.kill('SIGTERM');
      const deadline = Date.now() + 10_000;
      while (!exited && Date.now() < deadline) await sleep(100);
      if (!exited) child.kill('SIGKILL');
    },
  };
}

/**
 * Minimal cookie-aware HTTP client: keeps the session cookie between calls so
 * login → authenticated request works like a browser.
 */
export function createClient(baseUrl) {
  let cookie = '';

  async function request(method, pathname, { body, headers = {}, raw = false } = {}) {
    const finalHeaders = { ...headers };
    if (cookie) finalHeaders.cookie = cookie;
    if (body !== undefined && !(body instanceof FormData)) {
      finalHeaders['content-type'] = 'application/json';
    }

    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });

    const setCookie = response.headers.getSetCookie?.() || [];
    if (setCookie.length) {
      const pairs = setCookie.map((entry) => entry.split(';')[0]);
      cookie = pairs.join('; ');
    }

    if (raw) return response;

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, body: json, text };
  }

  return {
    get: (pathname, options) => request('GET', pathname, options),
    post: (pathname, body, options) => request('POST', pathname, { ...options, body }),
    put: (pathname, body, options) => request('PUT', pathname, { ...options, body }),
    patch: (pathname, body, options) => request('PATCH', pathname, { ...options, body }),
    delete: (pathname, options) => request('DELETE', pathname, options),
    cookie: () => cookie,
  };
}

/**
 * Create a user directly through the API (first user bootstraps the instance).
 */
export async function loginAs(client, username, password) {
  const response = await client.post('/api/auth/login', { username, password });
  if (response.status !== 200) {
    throw new Error(`login failed for ${username}: ${response.status} ${response.text}`);
  }
  return response.body;
}

/**
 * Ensure a developer account exists on a fresh or already-configured database.
 *
 * Each integration test file runs in its own process against the same database,
 * so only the first one can create the instance. This helper handles both cases:
 * - empty database: runs setup and returns the new credentials;
 * - configured database: logs in with the shared admin credentials.
 *
 * Set `INTEGRATION_ADMIN_USER` / `INTEGRATION_ADMIN_PASSWORD` to control the
 * account used when the database already exists (defaults below).
 */
export async function ensureAdmin(client) {
  const username = process.env.INTEGRATION_ADMIN_USER || 'integration-admin';
  const password = process.env.INTEGRATION_ADMIN_PASSWORD || 'integration-password-123';

  const status = await client.get('/api/auth/status');
  assertOk(status, 'auth/status');

  if (status.body.setupRequired) {
    const setup = await client.post('/api/auth/setup', {
      username,
      displayName: 'Integration Admin',
      password,
    });
    assertOk(setup, 'auth/setup');
  }

  const login = await client.post('/api/auth/login', { username, password });
  if (login.status !== 200) {
    throw new Error(`admin login failed: ${login.status} ${login.text}`);
  }
  return login.body;
}

function assertOk(response, label) {
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`${label} returned ${response.status}: ${response.text}`);
  }
}
