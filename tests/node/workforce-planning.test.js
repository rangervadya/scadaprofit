import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHouseAddresses } from '../../backend/api/workforce-system.js';

const read = relative => readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('multi-house dispatch parses one house per line and removes duplicates', () => {
  assert.deepEqual(
    parseHouseAddresses('12\n12А\n14/2\n12а\n;\n16'),
    ['12', '12А', '14/2', '16']
  );
});

test('legacy single-address assignment remains supported', () => {
  assert.deepEqual(parseHouseAddresses('', '8Б'), ['8Б']);
  assert.deepEqual(parseHouseAddresses(undefined, '10/3'), ['10/3']);
});

test('house list is capped at 100 distinct addresses', () => {
  const addresses = Array.from({ length: 100 }, (_, index) => String(index + 1)).join('\n');
  assert.equal(parseHouseAddresses(addresses).length, 100);
  const tooMany = Array.from({ length: 101 }, (_, index) => String(index + 1)).join('\n');
  assert.throws(() => parseHouseAddresses(tooMany), /не более 100 домов/);
});

test('receivers can dispatch multiple house tasks to selected fitters', async () => {
  const backend = await read('backend/api/workforce-system.js');
  const html = await read('frontend/public/workforce.html');
  const js = await read('frontend/public/workforce.js');
  const route = backend.slice(
    backend.indexOf("routes.post('/api/workforce/tasks'"),
    backend.indexOf("routes.post('/api/workforce/tasks/:id/start'")
  );

  assert.match(route, /requireRoles\(req, res, \['receiver', 'supervisor', 'developer'\]\)/);
  assert.match(route, /parseHouseAddresses\(req\.body\?\.addresses, req\.body\?\.address\)/);
  assert.match(route, /const assignmentGroupId = randomUUID\(\)/);
  assert.match(route, /addresses\.map\(address =>/);
  assert.match(route, /createdCount: clientTasks\.length/);
  assert.match(html, /name="addresses"/);
  assert.match(html, /Каждый дом с новой строки/);
  assert.match(js, /function roleCanAssignTasks\(\) \{ return \['receiver', 'supervisor', 'developer'\]/);
  assert.match(js, /if \(roleCanAssignTasks\(\)\) tabs\.push\(\['scheduleSection', 'План работ'\]\)/);
  assert.match(js, /Сегодня/);
  assert.match(js, /loadOverview\(\)/);
});
