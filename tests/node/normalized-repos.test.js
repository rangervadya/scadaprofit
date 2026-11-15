// Normalized address library and workspace repositories (P1-14).
//
// These run against a scratch PostgreSQL when DATABASE_URL points at one, so the
// round-trip (write -> read -> same shape) is verified on real SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const hasDb = Boolean(process.env.NORMALIZED_DB_TEST_URL);

const lib = hasDb ? await import('../../services/ollama/api/repositories/address-library-repo.js') : null;
const ws = hasDb ? await import('../../services/ollama/api/repositories/workforce-workspace-repo.js') : null;

test('normalized: repos expose the same contract as before', async () => {
  const libSrc = await readFile(join(ROOT, 'services/ollama/api/repositories/address-library-repo.js'), 'utf8');
  assert.match(libSrc, /export async function fetchAddressLibrary/);
  assert.match(libSrc, /export async function saveAddressLibrary/);
  // Reads come from the normalized tables, not the JSONB singleton.
  assert.match(libSrc, /prisma\.addressStreet\.findMany/);
  assert.match(libSrc, /address_buildings|addressBuilding/);

  const wsSrc = await readFile(join(ROOT, 'services/ollama/api/repositories/workforce-workspace-repo.js'), 'utf8');
  assert.match(wsSrc, /export async function fetchWorkspace/);
  assert.match(wsSrc, /export async function saveWorkspace/);
  assert.match(wsSrc, /prisma\.workforceTask\.findMany/);
  assert.match(wsSrc, /prisma\.workforceReport\.findMany/);
  assert.match(wsSrc, /prisma\.workforceDefectReport\.findMany/);
});

test('normalized: schema declares the new tables with indexes', async () => {
  const schema = await readFile(join(ROOT, 'services/ollama/prisma/schema.prisma'), 'utf8');
  for (const model of [
    'model AddressStreet',
    'model AddressBuilding',
    'model AddressScheme',
    'model WorkforceTask',
    'model WorkforceReport',
    'model WorkforceDefectReport',
  ]) {
    assert.match(schema, new RegExp(model));
  }
  assert.match(schema, /@@map\("workforce_tasks"\)/);
  assert.match(schema, /@@index\(\[assignedTo\]\)/);
});

test('normalized: migration exists and backfills from the JSONB singletons', async () => {
  const { readdir } = await import('node:fs/promises');
  const dir = join(ROOT, 'services/ollama/prisma/migrations/20261116120000_normalize_address_and_workspace');
  const files = await readdir(dir);
  assert.ok(files.includes('migration.sql'));
  const sql = await readFile(join(dir, 'migration.sql'), 'utf8');
  assert.match(sql, /INSERT INTO "address_streets"/);
  assert.match(sql, /jsonb_array_elements\(COALESCE\(data->'streets'/);
  assert.match(sql, /INSERT INTO "workforce_tasks"/);
  assert.match(sql, /jsonb_array_elements\(COALESCE\(data->'tasks'/);
  assert.match(sql, /ON CONFLICT \("id"\) DO UPDATE/);
});

test('normalized: workspace round-trips without losing entities', { skip: hasDb ? false : 'no test DB' }, async () => {
  const before = await ws.fetchWorkspace();
  assert.ok(before, 'workspace should exist');
  const saved = await ws.saveWorkspace(before);
  assert.equal(saved, true);
  const after = await ws.fetchWorkspace();
  assert.equal(after.tasks.length, before.tasks.length);
  assert.equal(after.reports.length, before.reports.length);
  assert.equal(after.defectReports.length, before.defectReports.length);
  assert.deepEqual(after.tasks.map((t) => t.id).sort(), before.tasks.map((t) => t.id).sort());
});

test(
  'normalized: address library round-trips and stays queryable',
  { skip: hasDb ? false : 'no test DB' },
  async () => {
    const before = await lib.fetchAddressLibrary();
    assert.ok(before, 'library should exist');
    const saved = await lib.saveAddressLibrary(before);
    assert.equal(saved, true);
    const after = await lib.fetchAddressLibrary();
    assert.equal(after.streets.length, before.streets.length);
    for (const street of before.streets) {
      const match = after.streets.find((s) => s.id === street.id);
      assert.ok(match, `street ${street.id} missing`);
      assert.equal(match.buildings.length, street.buildings.length);
      for (const building of street.buildings) {
        const bm = match.buildings.find((b) => b.id === building.id);
        assert.ok(bm, `building ${building.id} missing`);
        assert.equal(bm.schemes.length, building.schemes.length);
      }
    }
  },
);
