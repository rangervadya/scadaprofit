// Single source of version truth (P2-9).
//
// `VERSION` is canonical. Every place that reports a release must match it, or
// a deploy can claim one version while the bundle contains another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

async function readJson(rel) {
  return JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
}

test('version: VERSION is the canonical value', async () => {
  const version = (await readFile(join(ROOT, 'VERSION'), 'utf8')).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, `VERSION is not semver: ${version}`);
});

test('version: package.json files match VERSION', async () => {
  const version = (await readFile(join(ROOT, 'VERSION'), 'utf8')).trim();
  for (const rel of ['services/ollama/package.json', 'frontend/package.json']) {
    const pkg = await readJson(rel);
    assert.equal(pkg.version, version, `${rel} version drifted`);
  }
});

test('version: lockfiles agree with VERSION at the root', async () => {
  const version = (await readFile(join(ROOT, 'VERSION'), 'utf8')).trim();
  for (const rel of ['services/ollama/package-lock.json', 'frontend/package-lock.json']) {
    const lock = await readJson(rel);
    assert.equal(lock.version, version, `${rel} root version drifted`);
    if (lock.packages?.['']) {
      assert.equal(lock.packages[''].version, version, `${rel} packages[""] version drifted`);
    }
  }
});

test('version: no hardcoded release label remains in app code', async () => {
  const version = (await readFile(join(ROOT, 'VERSION'), 'utf8')).trim();
  const sources = [
    'services/ollama/api/server.js',
    'services/ollama/api/services/workforce-system.js',
    'services/ollama/api/lib/logger.js',
    'services/ollama/api/lib/version.js',
  ];
  for (const rel of sources) {
    const src = await readFile(join(ROOT, rel), 'utf8');
    assert.ok(!src.includes(`'${version}'`) && !src.includes(`"${version}"`), `${rel} still hardcodes ${version}`);
  }
  // Node reports the version through the shared module.
  const wf = await readFile(join(ROOT, 'services/ollama/api/services/workforce-system.js'), 'utf8');
  assert.match(wf, /version: appVersion\(\)/);
  const logger = await readFile(join(ROOT, 'services/ollama/api/lib/logger.js'), 'utf8');
  assert.match(logger, /return appVersion\(\)/);
});

test('version: vdgo resolves the release from VERSION with an env override', async () => {
  const src = await readFile(join(ROOT, 'services/vdgo/app.py'), 'utf8');
  assert.match(src, /def _read_app_release\(\)/);
  assert.match(src, /os\.environ\.get\('APP_RELEASE'/);
  assert.match(src, /'VERSION'/);
});
