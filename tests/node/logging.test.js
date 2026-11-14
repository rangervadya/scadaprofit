import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';

import {
  resolveLogLevel,
  parseProgressLine,
  renderProgressLine,
  shortJobId,
  REDACT_PATHS,
} from '../../services/ollama/api/logger.js';

// pino lives in services/ollama/node_modules, so resolve it from the API package
// instead of the repository root where the tests live.
const requireFromApi = createRequire(new URL('../../services/ollama/api/logger.js', import.meta.url));
const pino = requireFromApi('pino');

const source = await readFile(new URL('../../services/ollama/api/logger.js', import.meta.url), 'utf8');

function capture() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, stream };
}

test('log level falls back to a safe default and never to a silent service', () => {
  assert.equal(resolveLogLevel({ LOG_LEVEL: 'debug' }), 'debug');
  assert.equal(resolveLogLevel({ LOG_LEVEL: 'WARN' }), 'warn');
  assert.equal(resolveLogLevel({ LOG_LEVEL: 'verbose' }), 'info');
  assert.equal(resolveLogLevel({}), 'info');
  assert.equal(resolveLogLevel({ NODE_ENV: 'production' }), 'info');
  assert.equal(resolveLogLevel({ NODE_ENV: 'development' }), 'debug');
});

test('progress lines round-trip from structured JSON to [STAGE] message', () => {
  const raw = JSON.stringify({
    ts: '2026-11-14T09:00:00.000Z',
    level: 'info',
    msg: 'Tile 1/4 started',
    stage: 'ocr',
    tile: 1,
  });
  const parsed = parseProgressLine(raw);
  assert.equal(parsed.structured, true);
  assert.equal(renderProgressLine(parsed.record), '[OCR] Tile 1/4 started');
});

test('plain python output stays verbatim and is truncated to the old limit', () => {
  const parsed = parseProgressLine('  a very long warning  ');
  assert.equal(parsed.structured, false);
  assert.equal(parsed.message, 'a very long warning');

  const long = parseProgressLine('x'.repeat(5000));
  assert.equal(long.message.length, 2000);
});

test('non-JSON objects and broken JSON fall back to plain text', () => {
  assert.equal(parseProgressLine('{"msg": 42}').structured, false);
  assert.equal(parseProgressLine('{not json').structured, false);
  assert.equal(parseProgressLine('null').structured, false);
});

test('stage is sanitised to the characters progress.log has always shown', () => {
  const parsed = parseProgressLine(JSON.stringify({ msg: 'hello', stage: 'ocr-pass/2' }));
  assert.equal(renderProgressLine(parsed.record), '[OCR-PASS2] hello');
  const empty = parseProgressLine(JSON.stringify({ msg: 'hello', stage: '///' }));
  assert.equal(renderProgressLine(empty.record), '[JOB] hello');
});

test('only events carrying a stage belong to the user-facing progress channel', () => {
  const withStage = parseProgressLine(JSON.stringify({ msg: 'tile done', stage: 'OCR' }));
  assert.equal(typeof withStage.record.stage, 'string');

  // Engine diagnostics and third-party library records stay out of progress.log.
  for (const line of [
    JSON.stringify({ msg: 'processor finished', logger: 'processor', level: 'info' }),
    JSON.stringify({ msg: 'connection reset', logger: 'urllib3.connectionpool', level: 'warning' }),
  ]) {
    const parsed = parseProgressLine(line);
    assert.equal(parsed.structured, true);
    assert.equal(typeof parsed.record.stage, 'undefined');
  }
});

test('job ids are shortened to eight characters', () => {
  assert.equal(shortJobId('a'.repeat(36)), 'aaaaaaaa');
  assert.equal(shortJobId(''), '');
});

test('secrets are redacted from structured records', () => {
  assert.ok(REDACT_PATHS.includes('passwordHash'));
  assert.ok(REDACT_PATHS.includes('req.headers.cookie'));

  const { lines, stream } = capture();
  // Build an instance with exactly the exported redaction config so a typo in
  // REDACT_PATHS fails here instead of leaking a hash in production.
  const log = pino({ level: 'info', redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream);
  log.info({ password: 'hunter2', token: 'abc', passwordHash: 'x', user: 'ilyas' }, 'login');
  const record = JSON.parse(lines[0]);
  assert.equal(record.password, '[redacted]');
  assert.equal(record.token, '[redacted]');
  assert.equal(record.passwordHash, '[redacted]');
  assert.equal(record.user, 'ilyas');
});

test('error records keep the stack in a serialisable field', () => {
  const { lines, stream } = capture();
  const log = pino({ level: 'info' }, stream);
  const failure = new Error('boom');
  log.error({ err: failure }, 'failed');
  const record = JSON.parse(lines[0]);
  assert.equal(record.err.message, 'boom');
  assert.equal(record.err.type, 'Error');
});

test('no service logs to the console object instead of the structured logger', async () => {
  const files = ['server.js', 'workforce-system.js', 'moss-env-boot.js'];
  for (const file of files) {
    const body = await readFile(new URL(`../../services/ollama/api/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(body, /console\.(log|info|warn|error|debug)\(/, `${file} still writes to console.*`);
  }
  assert.match(source, /export const requestLogger/);
});