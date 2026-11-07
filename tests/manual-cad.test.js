import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createManualCadProject,
  normalizeManualCadProject,
  renderManualCadSvg,
  renderManualCadDxf,
  isManualCadId
} from '../manual-cad-core.js';

test('creates isolated manual CAD project defaults', () => {
  const project = createManualCadProject({ title: 'Подъезд 2' });
  assert.equal(project.schema, 'scadaprofit.manual-cad.v1');
  assert.equal(project.title, 'Подъезд 2');
  assert.deepEqual(project.pipes, []);
  assert.equal(isManualCadId(project.id), true);
});

test('normalizes pipe geometry and explicit junctions without implicit crossing joins', () => {
  const base = createManualCadProject();
  const project = normalizeManualCadProject({
    ...base,
    width: 1000,
    height: 800,
    pipes: [
      { id: 'main', points: [[0, 10], [500, 10], [1000, 10]], name: 'Т-1', diameter: '25' },
      { id: 'branch', kind: 'branch', points: [[500, 10], [500, 400]], name: 'О-1' },
      { id: 'crossing', points: [[300, 0], [300, 700]] }
    ],
    junctions: [{ id: 'j1', x: 500, y: 10, pipeIds: ['main', 'branch'] }]
  }, base);
  assert.equal(project.pipes.length, 3);
  assert.equal(project.junctions.length, 1);
  assert.deepEqual(project.junctions[0].pipeIds, ['main', 'branch']);
  assert.equal(project.pipes[2].points.length, 2);
});

test('SVG export is a clean editable vector sheet, not a raster copy', () => {
  const base = createManualCadProject({ title: 'Тестовая схема' });
  const project = normalizeManualCadProject({
    ...base, width: 1000, height: 800,
    pipes: [{ id: 'p1', name: 'Т-1', diameter: '25', points: [[100,100],[400,100],[400,500]] }],
    junctions: [{ id: 'j1', x: 400, y: 100, pipeIds: ['p1','p2'] }],
    symbols: [{ id: 's1', type: 'meter', x: 400, y: 100, label: 'СЧ' }],
    labels: [{ id: 'l1', text: 'Подвал', x: 110, y: 120 }],
    dimensions: [{ id: 'd1', a: [100, 100], b: [400, 100], text: '1500 мм' }]
  }, base);
  const svg = renderManualCadSvg(project);
  assert.match(svg, /<svg[^>]+width="210mm"/);
  assert.match(svg, /id="PIPE_MAIN"/);
  assert.match(svg, /Т-1/);
  assert.match(svg, /Подвал/);
  assert.match(svg, /1500 мм/);
  assert.doesNotMatch(svg, /data:image/);
});

test('DXF export has separate engineering layers and editable entities', () => {
  const base = createManualCadProject({ title: 'DXF test' });
  const project = normalizeManualCadProject({
    ...base, pipes: [{ id: 'p1', name: 'T1', points: [[10,10],[100,10],[100,150]] }],
    symbols: [{ id: 'v1', type: 'valve', x: 100, y: 10 }],
    labels: [{ id: 'l1', text: 'DN25', x: 50, y: 20 }]
  }, base);
  const dxf = renderManualCadDxf(project);
  assert.match(dxf, /AC1015/);
  assert.match(dxf, /PIPE_MAIN/);
  assert.match(dxf, /SYMBOLS/);
  assert.match(dxf, /TEXT/);
  const cyrillicProject = normalizeManualCadProject({ ...base, title: 'Схема трубы' }, base);
  assert.match(renderManualCadDxf(cyrillicProject), /\\U\+0421/);
  assert.match(dxf, /0\nLINE/);
  assert.match(dxf, /0\nEOF/);
});
