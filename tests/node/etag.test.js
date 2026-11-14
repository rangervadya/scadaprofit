// Conditional GET / ETag (P2-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendJsonConditional } from '../../services/ollama/api/etag.js';

function fakeReq(headers = {}) {
  return { headers };
}

function fakeRes() {
  const state = { status: 200, headers: {}, body: undefined, ended: false };
  return {
    state,
    set(k, v) {
      state.headers[k.toLowerCase()] = v;
      return this;
    },
    type() {
      return this;
    },
    status(code) {
      state.status = code;
      return this;
    },
    send(body) {
      state.body = body;
      return this;
    },
    end() {
      state.ended = true;
      return this;
    },
  };
}

test('etag: first response carries a weak ETag and JSON body', () => {
  const res = fakeRes();
  sendJsonConditional(fakeReq(), res, { ok: true, tasks: [1, 2] });
  assert.equal(res.state.status, 200);
  assert.match(res.state.headers.etag, /^W="[A-Za-z0-9_-]+"$/);
  assert.equal(res.state.headers['cache-control'], 'private, no-cache');
  assert.deepEqual(JSON.parse(res.state.body), { ok: true, tasks: [1, 2] });
  assert.equal(res.state.ended, false);
});

test('etag: matching If-None-Match yields 304 with no body', () => {
  const res = fakeRes();
  const payload = { ok: true, tasks: [] };
  sendJsonConditional(fakeReq(), res, payload);
  const etag = res.state.headers.etag;

  const cached = fakeRes();
  sendJsonConditional(fakeReq({ 'if-none-match': etag }), cached, payload);
  assert.equal(cached.state.status, 304);
  assert.equal(cached.state.ended, true);
  assert.equal(cached.state.body, undefined);
});

test('etag: changed payload produces a different ETag', () => {
  const a = fakeRes();
  const b = fakeRes();
  sendJsonConditional(fakeReq(), a, { ok: true, v: 1 });
  sendJsonConditional(fakeReq(), b, { ok: true, v: 2 });
  assert.notEqual(a.state.headers.etag, b.state.headers.etag);
});

test('etag: read endpoints use sendJsonConditional', async () => {
  const { readFile } = await import('node:fs/promises');
  const wf = await readFile(new URL('../../services/ollama/api/workforce-system.js', import.meta.url), 'utf8');
  const srv = await readFile(new URL('../../services/ollama/api/server.js', import.meta.url), 'utf8');
  assert.match(wf, /sendJsonConditional\(req, res, \{ ok: true, tasks \}\)/);
  assert.match(wf, /sendJsonConditional\(req, res, \{ ok: true, users: visible\.map\(publicUser\) \}\)/);
  assert.match(srv, /sendJsonConditional\(req, res, \{ ok: true, projects \}\)/);
  assert.match(srv, /sendJsonConditional\(req, res, \{ ok: true, library \}\)/);
});
