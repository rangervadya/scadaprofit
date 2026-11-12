import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateAddressFolder } from '../../backend/api/workforce-system.js';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

const acceptedScheme = (overrides = {}) => ({
  id: 'scheme-1', taskId: 'task-house-10', status: 'accepted',
  schemeJobId: 'job-1', schemeStatus: 'completed', schemePartialGraphReady: false,
  seenBy: ['receiver-1'], ...overrides
});
const acceptedDefects = (overrides = {}) => ({
  id: 'defect-1', taskId: 'task-house-10', status: 'accepted',
  photos: [{ id: 'photo-1' }, { id: 'photo-2' }], seenBy: ['receiver-1'], ...overrides
});

test('an address folder is transferable only when all schemes and defect sets are accepted and visible', () => {
  const state = evaluateAddressFolder({
    schemes: [acceptedScheme()], defects: [acceptedDefects()], userId: 'receiver-1'
  });
  assert.equal(state.ready, true);
  assert.equal(state.items.length, 2);
  assert.equal(state.schemes.length, 1);
  assert.equal(state.defects.length, 1);
});

test('one pending or returned material blocks transfer of the complete address folder', () => {
  for (const status of ['processing', 'pending_review', 'revision_requested']) {
    const state = evaluateAddressFolder({
      schemes: [acceptedScheme(), acceptedScheme({ id: 'scheme-2', status })],
      defects: [acceptedDefects()], userId: 'receiver-1'
    });
    assert.equal(state.ready, false, `${status} must block the whole folder`);
    assert.equal(state.allAccepted, false);
  }
});

test('an unseen item blocks receiver folder transfer even if all materials are accepted', () => {
  const state = evaluateAddressFolder({
    schemes: [acceptedScheme()],
    defects: [acceptedDefects({ seenBy: [] })],
    userId: 'receiver-1'
  });
  assert.equal(state.unseenCount, 1);
  assert.equal(state.ready, false);
});

test('unfinished CAD or empty defect set blocks the complete folder transfer', () => {
  const waitingCad = evaluateAddressFolder({
    schemes: [acceptedScheme({ schemeStatus: 'queued' })],
    defects: [acceptedDefects()], userId: 'receiver-1'
  });
  assert.equal(waitingCad.schemesReady, false);
  assert.equal(waitingCad.ready, false);

  const noPhotos = evaluateAddressFolder({
    schemes: [acceptedScheme()], defects: [acceptedDefects({ photos: [] })], userId: 'receiver-1'
  });
  assert.equal(noPhotos.photosReady, false);
  assert.equal(noPhotos.ready, false);
});

test('a correction-replaced report does not block or enter the address folder', () => {
  const state = evaluateAddressFolder({
    schemes: [acceptedScheme(), acceptedScheme({ id: 'old-scheme', status: 'superseded', schemeStatus: 'failed' })],
    defects: [acceptedDefects()], userId: 'receiver-1'
  });
  assert.equal(state.items.length, 2);
  assert.equal(state.ready, true);
});

test('inbox UI groups materials by assigned house and offers only one folder transfer action', async () => {
  const js = await read('frontend/public/workforce.js');
  const html = await read('frontend/public/workforce.html');
  assert.match(js, /function buildInboxFolders\(\)/);
  assert.match(js, /map\.get\(item\.taskId\)/);
  assert.match(js, /data-inbox-folder=/);
  assert.match(js, /data-open-folder-cad/);
  assert.match(js, /data-accept-defect/);
  assert.match(js, /id="addFolderToConclusionBtn"/);
  assert.doesNotMatch(js, /addDefectsToConclusionBtn|addToConclusionBtn/);
  assert.match(html, /Папки по адресам/);
  assert.match(html, /Внутри будут все схемы и фотографии дефектов этого дома/);
});

test('CAD editor saves its edits and returns to the selected address folder without individual transfer', async () => {
  const js = await read('frontend/public/manual-cad.js');
  const html = await read('frontend/public/manual-cad.html');
  assert.match(html, /Сохранить и вернуться в папку/);
  assert.match(js, /await saveProject\(\)/);
  assert.ok(js.includes('window.location.href = `/workforce.html?report=${encodeURIComponent(reportId)}`'));
  assert.doesNotMatch(js, /api\/workforce\/reports.*conclusion/);
});

test('backend exposes one atomic folder-level transfer and rejects legacy per-item transfers', async () => {
  const backend = await read('backend/api/workforce-system.js');
  assert.match(backend, /export function evaluateAddressFolder/);
  assert.match(backend, /routes\.post\('\/api\/workforce\/tasks\/:taskId\/conclusion'/);
  assert.match(backend, /report\.conclusionFolderId = task\.id/);
  assert.match(backend, /report\.status !== 'superseded'/);
  assert.match(backend, /только целой папкой адреса/);
  assert.match(backend, /только вместе со всей папкой адреса/);
});
