import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeAcceptedWorkforceDefects } from '../../frontend/src/pages/conclusion/workforceDefects.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

 test('accepted fitter defect comments prefill the existing defect table row but do not invent a recommendation', () => {
  const merged = mergeAcceptedWorkforceDefects([], [
    { id: 'accepted-1', status: 'accepted', street: 'Ленина', address: '10', note: 'Коррозия на газовой трубе в подъезде №2' },
    { id: 'pending-2', status: 'pending_review', street: 'Ленина', address: '10', note: 'Ожидает проверки' },
  ], 'task-10', 11);
  assert.equal(merged.imported, 1);
  assert.equal(merged.overflow, 0);
  const row = merged.rows.find(item => item.workforceReportId === 'accepted-1');
  assert.ok(row);
  assert.equal(row.enabled, true);
  assert.equal(row.location, 'Ленина, дом 10');
  assert.equal(row.text, 'Коррозия на газовой трубе в подъезде №2');
  assert.equal(row.recommendation, '');
  assert.equal(row.workforceTaskId, 'task-10');
  assert.equal(merged.rows.some(item => item.workforceReportId === 'pending-2'), false);
});

test('accepted task materials populate the unchanged conclusion sections and native PDF form fields', async () => {
  const conclusionPage = await readFile(path.join(ROOT, 'frontend/src/pages/ConclusionPage.tsx'), 'utf8');
  const sections = await readFile(path.join(ROOT, 'frontend/src/pages/conclusion/ConclusionSections.tsx'), 'utf8');
  const schema = await readFile(path.join(ROOT, 'frontend/src/pages/conclusion/schema.ts'), 'utf8');
  const formHook = await readFile(path.join(ROOT, 'frontend/src/pages/conclusion/useConclusionForm.ts'), 'utf8');
  const backend = await readFile(path.join(ROOT, 'services/vdgo/backend/app.py'), 'utf8');

  assert.match(conclusionPage, /form\.applyWorkforceDefects\(context\.defectReports\s*\|\|\s*\[\],\s*context\.task\.id\)/);
  assert.match(conclusionPage, /buildWorkforceSchemes\(materials\.schemes\)/);
  assert.match(conclusionPage, /buildDefectPhotos\(materials\.defects\)/);
  assert.match(conclusionPage, /form\.buildFormData\(schemes,\s*defectPhotos\)/);
  assert.match(sections, /<span className="form-section__num">5<\/span>[\s\S]*?<h2>Дефекты<\/h2>/);
  assert.match(sections, /<span className="form-section__num">7<\/span>[\s\S]*?<h2>Фотографии объекта<\/h2>/);
  assert.match(sections, /<span className="form-section__num">8<\/span>[\s\S]*?<h2>Актуальные схемы, удостоверения и акты<\/h2>/);
  assert.match(formHook, /fields\[`defect_\$\{i\}_text`\]\s*=\s*row\.text/);
  assert.match(formHook, /form\.append\(`photo_\$\{photos\.length \+ index \+ 1\}`/);
  assert.match(formHook, /form\.append\('workforce_schemes_json'/);
  assert.match(backend, /overlay_defects\(doc,defects\)/);
  assert.match(backend, /append_workforce_scheme_pages\(doc, workforce_schemes or \[\], form\)/);
  assert.match(backend, /place_photos\(doc,photo_paths\)/);
});

test('existing conclusion section names and numbering remain unchanged', async () => {
  const schema = await readFile(path.join(ROOT, 'frontend/src/pages/conclusion/schema.ts'), 'utf8');
  const expected = [
    ['1', 'Основные данные'],
    ['2', 'Заказчик и специалисты'],
    ['3', 'Данные УЗТ и остаточный ресурс'],
    ['4', 'Таблицы УЗТ и расчёт ресурса'],
    ['5', 'Дефекты'],
    ['6', 'Арматура и результаты проверок'],
    ['7', 'Фотографии объекта'],
    ['8', 'Актуальные схемы, удостоверения и акты'],
    ['9', 'Проверка герметичности'],
  ];
  for (const [num, title] of expected) {
    assert.match(schema, new RegExp(`num: '${num}'[\\s\\S]*?title: '${title.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}'`), `Section ${num} and its title must remain unchanged`);
  }
  const sections = await readFile(path.join(ROOT, 'frontend/src/pages/conclusion/ConclusionSections.tsx'), 'utf8');
  assert.match(schema, /id: 'uzt',[\s\S]*?kind: 'uzt'/);
  assert.match(sections, /export function UztSection/);
  assert.match(sections, /section.kind === 'uzt'.*UztSection/);
});
