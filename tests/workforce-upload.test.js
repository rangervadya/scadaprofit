import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { persistUploadedFile } from '../workforce-system.js';

const makeTempDir = async (base, prefix) => mkdtemp(path.join(base, prefix));

test('persistUploadedFile safely stores a Multer upload across filesystem boundaries', async () => {
  const sourceDir = await makeTempDir(os.tmpdir(), 'wf-upload-source-');
  let destinationBase = os.tmpdir();
  let crossDevice = false;
  try {
    await access('/dev/shm');
    const sourceDevice = (await stat(sourceDir)).dev;
    const sharedMemoryDevice = (await stat('/dev/shm')).dev;
    if (sourceDevice !== sharedMemoryDevice) {
      destinationBase = '/dev/shm';
      crossDevice = true;
    }
  } catch {
    // /dev/shm is not available on every platform; same-filesystem behavior is
    // still tested, while production uses the same copy-then-rename strategy.
  }

  const destinationDir = await makeTempDir(destinationBase, 'wf-upload-destination-');
  const sourcePath = path.join(sourceDir, 'multer-temp-upload');
  const destinationPath = path.join(destinationDir, 'saved-sketch.jpg');
  const payload = Buffer.from('example hand-drawn sketch payload');

  try {
    await writeFile(sourcePath, payload);
    await chmod(sourcePath, 0o600);
    if (crossDevice) {
      assert.notEqual((await stat(sourcePath)).dev, (await stat(destinationDir)).dev);
    }

    const savedPath = await persistUploadedFile(sourcePath, destinationPath);

    assert.equal(savedPath, destinationPath);
    assert.deepEqual(await readFile(destinationPath), payload);
    await assert.rejects(access(sourcePath), { code: 'ENOENT' });
    assert.deepEqual(await readdir(destinationDir), ['saved-sketch.jpg']);
    assert.equal((await stat(destinationPath)).mode & 0o777, 0o600);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(destinationDir, { recursive: true, force: true });
  }
});

test('workforce report uploads use the cross-device-safe persistence helper', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../workforce-system.js', import.meta.url), 'utf8');
  assert.match(source, /await persistUploadedFile\(file\.path, path\.join\(reportDir, fileName\)\)/);
  const persistBody = source.slice(source.indexOf('export async function persistUploadedFile'), source.indexOf('export async function createWorkforceSystem'));
  assert.match(persistBody, /await copyFile\(sourcePath, stagingPath\)/);
  assert.match(persistBody, /await rename\(stagingPath, destinationPath\)/);
  assert.doesNotMatch(source, /await rename\(file\.path, path\.join\(reportDir, fileName\)\)/);
});
