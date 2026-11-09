import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createManualCadProject,
  createManualCadProjectFromGraph,
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


test('merges continuous primary segments while leaving crossings unconnected', () => {
  const graph = {
    image: { width: 1200, height: 800 }, complete: false, analysisStatus: 'incomplete',
    nodes: [
      { id: 'N0', x: 100, y: 100, degree: 1, review: false },
      { id: 'N1', x: 200, y: 100, degree: 2, review: false },
      { id: 'N2', x: 300, y: 100, degree: 3, review: false },
      { id: 'N3', x: 300, y: 220, degree: 1, review: false },
      { id: 'N4', x: 420, y: 100, degree: 1, review: false },
      { id: 'M1', x: 200, y: 300, degree: 1, review: false },
      { id: 'M2', x: 400, y: 300, degree: 1, review: false },
      { id: 'M3', x: 300, y: 200, degree: 1, review: false },
      { id: 'M4', x: 300, y: 400, degree: 1, review: false },
      { id: 'N5', x: 900, y: 100, degree: 1, review: true }
    ],
    edges: [
      { id: 'E1', from: 'N0', to: 'N1', cad_include: true, geometry: [[100, 100], [150, 100], [200, 100]] },
      { id: 'E2', from: 'N1', to: 'N2', cad_include: true, geometry: [[300, 100], [250, 100], [200, 100]] },
      { id: 'E3', from: 'N2', to: 'N3', cad_include: true, kind: 'branch', geometry: [[300, 100], [300, 160], [300, 220]] },
      { id: 'E4', from: 'N2', to: 'N4', source: 'manual', detector: 'MANUAL', geometry: [[300, 100], [420, 100]] },
      { id: 'C1', from: 'M1', to: 'M2', cad_include: true, geometry: [[200, 300], [400, 300]] },
      { id: 'C2', from: 'M3', to: 'M4', cad_include: true, geometry: [[300, 200], [300, 400]] },
      { id: 'E5', from: 'N2', to: 'N5', cad_include: false, geometry: [[300, 100], [900, 100]] }
    ],
    crossings: [{ edge_ids: ['E1', 'E3'], x: 600, y: 200 }],
    confirmedConnections: [{ edgeId: 'E2', confirmation: 'explicit-user-action' }],
    documentModel: {
      labels: [{ id: 'L1', text: 'DN 25?', bbox: { x: 40, y: 60, w: 80, h: 24 }, state: 'review' }],
      dimensions: [{ id: 'D1', sourceAnnotationId: 'L2', rawText: '1500', bbox: { x: 500, y: 300, w: 48, h: 20 } }],
      symbols: [
        { id: 'S1', visualClass: 'unknown_compact_mark', bbox: { x: 700, y: 300, w: 30, h: 30 }, state: 'review' },
        { id: 'S2', type: 'valve', bbox: { x: 200, y: 100, w: 20, h: 20 }, state: 'primary' },
        { id: 'S3', type: 'meter', bbox: { x: 800, y: 400, w: 20, h: 20 }, state: 'review' }
      ]
    }
  };
  const project = createManualCadProjectFromGraph(graph, { title: 'Улица, дом 7' });
  assert.equal(project.width, 1200);
  assert.equal(project.height, 800);
  assert.equal(project.drawingStyle, 'lpgcad-r1');
  assert.equal(project.paperSize, 'A4');
  assert.equal(project.pipes.length, 5);
  assert.deepEqual(new Set(project.pipes.map(pipe => pipe.id)), new Set(['E1', 'E3', 'E4', 'C1', 'C2']));
  const mergedMain = project.pipes.find(pipe => pipe.id === 'E1');
  assert.equal(mergedMain.points.length, 5, 'two segments through a degree-2 node become one route');
  assert.deepEqual(mergedMain.points[0], [100, 100]);
  assert.deepEqual(mergedMain.points.at(-1), [300, 100]);
  assert.equal(project.junctions.length, 1);
  assert.deepEqual(new Set(project.junctions[0].pipeIds), new Set(['E1', 'E3', 'E4']));
  assert.equal(project.junctions[0].x, 300);
  assert.equal(project.junctions[0].y, 100);
  assert.equal(project.labels.length, 2);
  assert.equal(project.labels[0].text, 'DN 25?');
  assert.equal(project.labels[1].text, '1500');
  assert.equal(project.symbols.length, 1);
  assert.equal(project.symbols[0].type, 'valve');
  assert.equal(project.dimensions.length, 0, 'dimension values without measured endpoints stay text labels');
  assert.match(project.notes, /НЕ ЗАВЕРШЕНА/);
  assert.match(project.notes, /Пересечения автоматически не соединяются/);
});

test('uncertain and short isolated segments stay review-only and are excluded from clean exports until accepted', () => {
  const graph = {
    image: { width: 500, height: 400 }, complete: true,
    nodes: [
      { id: 'A', x: 30, y: 40 }, { id: 'B', x: 180, y: 40 },
      { id: 'C', x: 220, y: 140 }, { id: 'D', x: 225, y: 140 },
      { id: 'E', x: 250, y: 250 }, { id: 'F', x: 410, y: 250 }
    ],
    edges: [
      { id: 'MAIN', from: 'A', to: 'B', cad_include: true, component_role: 'line_structure', geometry: [[30,40],[180,40]] },
      { id: 'TICK', from: 'C', to: 'D', cad_include: true, component_role: 'line_structure', geometry: [[220,140],[225,140]] },
      { id: 'AMB', from: 'E', to: 'F', cad_include: true, component_role: 'ambiguous', geometry: [[250,250],[330,250],[410,250]] }
    ],
    documentModel: { labels: [], symbols: [] }
  };
  const project = createManualCadProjectFromGraph(graph);
  assert.equal(project.pipes.filter(pipe => pipe.reviewOnly !== true).length, 1);
  assert.equal(project.pipes.filter(pipe => pipe.reviewOnly === true).length, 2);
  const svg = renderManualCadSvg(project);
  assert.match(svg, /id="MAIN"/);
  assert.doesNotMatch(svg, /id="TICK"/);
  assert.doesNotMatch(svg, /id="review_AMB"/);
  const dxf = renderManualCadDxf(project);
  assert.match(dxf, /MAIN/);
  assert.doesNotMatch(dxf, /review_AMB/);
  const accepted = normalizeManualCadProject({
    ...project,
    pipes: project.pipes.map(pipe => pipe.id === 'review_AMB' ? { ...pipe, reviewOnly: false, reviewReason: '' } : pipe)
  }, project);
  assert.equal(accepted.pipes.find(pipe => pipe.id === 'review_AMB').reviewOnly, false);
  assert.match(renderManualCadSvg(accepted), /review_AMB/);
});

test('topology-supported edges form the main layer while other selected edges are retained for review', () => {
  const graph = {
    image: { width: 600, height: 400 }, complete: true,
    nodes: [
      { id: 'A', x: 20, y: 40 }, { id: 'B', x: 280, y: 40 },
      { id: 'C', x: 40, y: 160 }, { id: 'D', x: 220, y: 160 },
      { id: 'E', x: 300, y: 300 }, { id: 'F', x: 500, y: 300 }
    ],
    edges: [
      { id: 'NETWORK', from: 'A', to: 'B', cad_include: true, component_role: 'line_structure', topology_network_candidate: true, geometry: [[20,40],[280,40]] },
      { id: 'UNVERIFIED', from: 'C', to: 'D', cad_include: true, component_role: 'line_structure', topology_network_candidate: false, geometry: [[40,160],[220,160]] },
      { id: 'AMBIGUOUS', from: 'E', to: 'F', cad_include: true, component_role: 'ambiguous', topology_network_candidate: false, geometry: [[300,300],[500,300]] }
    ]
  };
  const project = createManualCadProjectFromGraph(graph);
  assert.equal(project.pipes.filter(pipe => pipe.reviewOnly !== true).length, 1);
  assert.equal(project.pipes.filter(pipe => pipe.reviewOnly === true).length, 2);
  assert.equal(project.pipes.find(pipe => pipe.id === 'NETWORK').reviewOnly, false);
  assert.ok(project.pipes.find(pipe => pipe.id === 'review_UNVERIFIED').reviewOnly);
  assert.ok(project.pipes.find(pipe => pipe.id === 'review_AMBIGUOUS').reviewOnly);
  const svg = renderManualCadSvg(project);
  assert.match(svg, /id="NETWORK"/);
  assert.doesNotMatch(svg, /UNVERIFIED/);
  assert.doesNotMatch(svg, /AMBIGUOUS/);
});

test('LPGCad R1 profile keeps source geometry editable and adds an engineering sheet header and legend', () => {
  const base = createManualCadProject({ title: 'Схема газоснабжения · дом 105' });
  const project = normalizeManualCadProject({
    ...base,
    drawingStyle: 'lpgcad-r1', paperSize: 'A4', page: 'portrait',
    siteAddress: 'Республика Татарстан, г. Казань, ул. Юлиуса Фучика, д. 105',
    entrance: '2', schemeAuthor: 'А. А. Козлов', schemeChecker: 'А. Д. Степанов',
    pipes: [
      { id: 'main', kind: 'pipe', name: 'Т-1', diameter: '25', points: [[80, 80], [420, 80], [420, 440]] },
      { id: 'riser-1', kind: 'riser', name: 'Стояк 1', points: [[420, 440], [420, 820]] },
      { id: 'branch-1', kind: 'branch', points: [[420, 200], [650, 200]] }
    ],
    junctions: [{ id: 'j1', x: 420, y: 200, pipeIds: ['main', 'branch-1'] }],
    symbols: [
      { id: 'meter-1', type: 'meter', x: 420, y: 440, label: 'G-1' },
      { id: 'valve-1', type: 'valve', x: 650, y: 200, label: 'Кран' }
    ],
    labels: [{ id: 'label-1', text: 'Квартира 13', x: 680, y: 205 }],
    dimensions: [{ id: 'dim-1', a: [80, 80], b: [420, 80], text: '1500 мм' }]
  }, base);

  const svg = renderManualCadSvg(project);
  assert.match(svg, /width="210mm" height="297mm"/);
  assert.match(svg, /ПРОДОЛЖЕНИЕ ПРИЛОЖЕНИЯ/);
  assert.match(svg, /ул\. Юлиуса Фучика, д\. 105/);
  assert.match(svg, /подъезд 2/);
  assert.match(svg, /УСЛОВНЫЕ ОБОЗНАЧЕНИЯ/);
  assert.match(svg, /Схему составил: А\. А\. Козлов/);
  assert.match(svg, /id="RISERS"/);
  assert.match(svg, /id="BRANCH"/);
  assert.match(svg, /1500 мм/);
  assert.match(svg, /Квартира 13/);
  assert.doesNotMatch(svg, /data:image/);

  const dxf = renderManualCadDxf(project);
  assert.match(dxf, /RISERS/);
  assert.match(dxf, /LEGEND/);
  assert.match(dxf, /HEADER/);
  assert.match(dxf, /1500/);
  assert.match(dxf, /\\U\+041A/);
  assert.match(dxf, /0\nEOF/);
});

test('legacy LPGCad subtitle is normalized so the printed heading is not duplicated', () => {
  const base = createManualCadProject();
  const project = normalizeManualCadProject({
    ...base, drawingStyle: 'lpgcad-r1',
    schemeSubtitle: 'Схема неразрушающего контроля внутридомового газового оборудования'
  }, base);
  assert.equal(project.schemeSubtitle, 'неразрушающего контроля внутридомового газового оборудования');
  const svg = renderManualCadSvg(project);
  assert.match(svg, />Схема<\/text>/);
  assert.doesNotMatch(svg, />Схема Схема неразрушающего контроля/);
});

test('normalizer accepts A3 sheets and riser pipe kind while clamping unsupported styles', () => {
  const base = createManualCadProject();
  const project = normalizeManualCadProject({
    ...base, drawingStyle: 'lpgcad-r1', paperSize: 'A3',
    pipes: [{ id: 'riser', kind: 'riser', points: [[10, 10], [10, 200]] }]
  }, base);
  assert.equal(project.paperSize, 'A3');
  assert.equal(project.drawingStyle, 'lpgcad-r1');
  assert.equal(project.pipes[0].kind, 'riser');
  const svg = renderManualCadSvg(project);
  assert.match(svg, /width="297mm" height="420mm"/);
});


test('LPGCad R1 lays out explicitly entered riser groups in SVG and editable DXF layer', () => {
  const base = createManualCadProject({ title: 'Дом 105 · подъезд 2' });
  const project = normalizeManualCadProject({
    ...base, drawingStyle: 'lpgcad-r1', paperSize: 'A4', page: 'portrait',
    riserGroups: [
      { id: 'st-5', name: 'Ст-5', apartments: ['67', '63', '59', '55', '51'] },
      { id: 'st-6', name: 'Ст-6', apartments: ['68', '64', '60', '56', '52'] }
    ]
  }, base);
  assert.equal(project.riserGroups.length, 2);
  assert.deepEqual(project.riserGroups[0].apartments, ['67', '63', '59', '55', '51']);
  const svg = renderManualCadSvg(project);
  assert.match(svg, /id="RISER_GROUPS"/);
  assert.match(svg, /ГРУППЫ СТОЯКОВ/);
  assert.match(svg, /Ст-5/);
  assert.match(svg, /Ст-6/);
  assert.match(svg, />67</);
  assert.match(svg, />52</);
  assert.match(svg, /труба-футляр/);
  const riserBlock = svg.match(/<g id="RISER_GROUPS"[\s\S]*?<\/g>/)?.[0] || '';
  const legendBlock = svg.match(/<g id="LEGEND"[\s\S]*?<\/g>/)?.[0] || '';
  const riserRect = riserBlock.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
  const legendRect = legendBlock.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
  assert.ok(riserRect && legendRect, 'riser and legend sheet blocks should be present');
  const riserRight = Number(riserRect[1]) + Number(riserRect[3]);
  const legendLeft = Number(legendRect[1]);
  assert.ok(riserRight < legendLeft, 'riser columns must stay on the left of the legend');
  assert.ok(Number(riserRect[2]) + Number(riserRect[4]) > Number(legendRect[2]), 'riser columns and legend should share the lower sheet band');
  const dxf = renderManualCadDxf(project);
  assert.match(dxf, /RISER_GROUPS/);
  assert.match(dxf, /\\U\+0421\\U\+0442-5/);
  assert.match(dxf, /0\nLWPOLYLINE\n100\nAcDbEntity\n8\nRISER_GROUPS\n100\nAcDbPolyline/);
  assert.match(dxf, /0\nEOF/);
});

test('house-scheme conversion creates one address-linked LPGCad R1 project from the graph', () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  const graph = {
    image: { width: 1200, height: 800 }, complete: true,
    nodes: [{ id: 'N1', x: 100, y: 100, degree: 3, review: false }, { id: 'N2', x: 500, y: 100, degree: 1, review: false }],
    edges: [{ id: 'E1', from: 'N1', to: 'N2', cad_include: true, geometry: [[100,100],[300,100],[500,100]] }],
    primarySemanticRoutes: [{ id: 'Q1', primary_validated: true, points: [[500,100],[650,100],[650,260]] }],
    semanticRoutes: [{ id: 'Q-review', primary_validated: false, points: [[100,200],[800,200]] }],
    documentModel: { labels: [{ id: 'L1', text: 'DN 25', x: 180, y: 80 }] }
  };
  const project = createManualCadProjectFromGraph(graph, {
    title: 'Схема подъезда 2', siteAddress: 'ул. Лесная, дом 12', entrance: '2',
    sourceJobId: jobId, sourceStreetId: 'street-1', sourceBuildingId: 'house-12'
  });
  assert.equal(project.drawingStyle, 'lpgcad-r1');
  assert.equal(project.sourceJobId, jobId);
  assert.equal(project.siteAddress, 'ул. Лесная, дом 12');
  assert.equal(project.analysisComplete, true);
  assert.equal(project.pipes.length, 2);
  assert.equal(project.pipes[1].source, 'qwen-ink-validated');
  const svg = renderManualCadSvg(project);
  assert.match(svg, /ул\. Лесная, дом 12/);
  assert.match(svg, /DN 25/);
});

test('manual CAD save metadata keeps the originating house scheme link and edit revision', () => {
  const base = createManualCadProject({ title: 'Схема дома' });
  const sourceJobId = '22222222-2222-4222-8222-222222222222';
  const linked = normalizeManualCadProject({
    ...base, sourceJobId, sourceStreetId: 'street-2', sourceBuildingId: 'house-7',
    analysisComplete: false, manualEditRevision: 3, siteAddress: 'ул. Мира, дом 7'
  }, base);
  const saved = normalizeManualCadProject({ ...linked, title: 'Исправленная схема' }, linked);
  assert.equal(saved.sourceJobId, sourceJobId);
  assert.equal(saved.sourceStreetId, 'street-2');
  assert.equal(saved.sourceBuildingId, 'house-7');
  assert.equal(saved.analysisComplete, false);
  assert.equal(saved.manualEditRevision, 3);
  assert.equal(saved.siteAddress, 'ул. Мира, дом 7');
});

test('numbered callout symbols stay editable in both SVG and DXF exports', () => {
  const base = createManualCadProject({ title: 'Схема с контрольными точками' });
  const project = normalizeManualCadProject({
    ...base,
    symbols: [{ id: 'callout-24', type: 'callout', x: 260, y: 180, label: '24', scale: 1.1, rotation: 0 }]
  }, base);
  assert.equal(project.symbols[0].type, 'callout');
  const svg = renderManualCadSvg(project);
  assert.match(svg, /<rect[^>]+width=/);
  assert.match(svg, />24</);
  const dxf = renderManualCadDxf(project);
  assert.match(dxf, /0\nLINE\n8\nSYMBOLS/);
  assert.match(dxf, /0\nTEXT\n8\nTEXT/);
  assert.match(dxf, /24/);
});


test('sketch-assist imports high-recall line components and pairs trunk through a branch while preserving the branch', () => {
  const graph = {
    image: { width: 500, height: 400 }, complete: true,
    nodes: [
      { id: 'A', x: 20, y: 100 }, { id: 'B', x: 140, y: 100 },
      { id: 'C', x: 260, y: 100 }, { id: 'D', x: 140, y: 260 }
    ],
    components: [
      { id: 'L1', role: 'line_structure', edge_count: 3, total_length: 400 },
      { id: 'AUX', role: 'ambiguous', connected_line_candidate: false, elbow_route_candidate: false, topology_network_candidate: false, dense_route_exemption: false }
    ],
    edges: [
      { id: 'AB', component_id: 'L1', component_role: 'line_structure', cad_include: true, topology_network_candidate: false, from: 'A', to: 'B', geometry: [[20,100],[140,100]] },
      { id: 'BC', component_id: 'L1', component_role: 'line_structure', cad_include: true, topology_network_candidate: false, from: 'B', to: 'C', geometry: [[140,100],[260,100]] },
      { id: 'BD', component_id: 'L1', component_role: 'line_structure', cad_include: true, topology_network_candidate: false, kind: 'branch', from: 'B', to: 'D', geometry: [[140,100],[140,260]] },
      { id: 'NOISE', component_id: 'AUX', component_role: 'ambiguous', cad_include: true, topology_network_candidate: false, from: 'A', to: 'D', geometry: [[20,100],[140,260]] }
    ],
    documentModel: {
      labels: [], dimensions: [],
      symbols: [{ id: 'U1', visualClass: 'unknown_compact_mark', bbox: { x: 300, y: 100, w: 20, h: 24 }, state: 'review', confidence: 0.72 }]
    }
  };
  const project = createManualCadProjectFromGraph(graph);
  assert.equal(project.sketchAssist.enabled, true);
  assert.equal(project.pipes.length, 2, 'only line_structure component is imported; unrelated ambiguous noise is excluded');
  assert.equal(project.pipes.filter(pipe => pipe.reviewOnly).length, 2, 'unverified hand-drawn routes remain review-only');
  const trunk = project.pipes.find(pipe => pipe.points.some(point => point[0] === 20) && pipe.points.some(point => point[0] === 260));
  const branch = project.pipes.find(pipe => pipe.kind === 'branch');
  assert.ok(trunk, 'opposing edges join into one trunk across the junction');
  assert.equal(trunk.points.length, 3);
  assert.ok(branch, 'side branch remains a separate editable polyline');
  assert.equal(project.symbols.length, 1);
  assert.equal(project.symbols[0].type, 'unknown');
  assert.equal(project.symbols[0].reviewOnly, true);
  assert.doesNotMatch(renderManualCadSvg(project), /unknown|\?>/);
  assert.doesNotMatch(renderManualCadDxf(project), /\n0\nCIRCLE\n8\nSYMBOLS/);
});



test('normalizer preserves operator-confirmed ink-traced route provenance and compact metrics', () => {
  const base = createManualCadProject({ title: 'Ink route' });
  const project = normalizeManualCadProject({
    ...base,
    pipes: [{ id: 'ink-main', source: 'ink-trace-assist', traceMetrics: [{ inkSupport: 0.84, lengthPx: 244.5, visited: 1400 }], points: [[10, 10], [80, 20], [100, 90]] }]
  }, base);
  assert.equal(project.pipes[0].source, 'ink-trace-assist');
  assert.deepEqual(project.pipes[0].traceMetrics, [{ inkSupport: 0.84, lengthPx: 244.5, visited: 1400 }]);
});

test('component line edges not selected for primary CAD remain visible as review candidates', () => {
  const graph = {
    image: { width: 700, height: 500 }, complete: true,
    nodes: [
      { id: 'A', x: 30, y: 80 }, { id: 'B', x: 230, y: 80 },
      { id: 'C', x: 260, y: 100 }, { id: 'D', x: 520, y: 100 }
    ],
    components: [{ id: 'ROUTE', role: 'line_structure', edge_count: 2, total_length: 460 }],
    edges: [
      { id: 'MAIN', component_id: 'ROUTE', component_role: 'line_structure', cad_include: true, topology_network_candidate: true, from: 'A', to: 'B', geometry: [[30,80],[230,80]] },
      { id: 'REVIEW_SEGMENT', component_id: 'ROUTE', component_role: 'line_structure', cad_include: false, topology_network_candidate: false, from: 'C', to: 'D', geometry: [[260,100],[390,100],[520,100]] }
    ],
    documentModel: { labels: [], symbols: [] }
  };
  const project = createManualCadProjectFromGraph(graph);
  assert.ok(project.pipes.some(pipe => pipe.id === 'MAIN' && !pipe.reviewOnly));
  const candidate = project.pipes.find(pipe => pipe.id === 'review_REVIEW_SEGMENT');
  assert.ok(candidate, 'unselected edge from a route component remains visible for inspection');
  assert.equal(candidate.reviewOnly, true);
  assert.doesNotMatch(renderManualCadSvg(project), /REVIEW_SEGMENT/);
});

test('sketch-assist treats a four-way crossing as two continuous routes, not one joined junction', () => {
  const graph = {
    image: { width: 400, height: 300 }, complete: true,
    nodes: [
      { id: 'W', x: 30, y: 120 }, { id: 'X', x: 180, y: 120 },
      { id: 'E', x: 330, y: 120 }, { id: 'N', x: 180, y: 30 },
      { id: 'S', x: 180, y: 270 }
    ],
    components: [{ id: 'CROSS', role: 'line_structure', edge_count: 4, total_length: 510 }],
    edges: [
      { id: 'W-X', component_id: 'CROSS', cad_include: true, topology_network_candidate: false, from: 'W', to: 'X', geometry: [[30,120],[180,120]] },
      { id: 'X-E', component_id: 'CROSS', cad_include: true, topology_network_candidate: false, from: 'X', to: 'E', geometry: [[180,120],[330,120]] },
      { id: 'N-X', component_id: 'CROSS', cad_include: true, topology_network_candidate: false, from: 'N', to: 'X', geometry: [[180,30],[180,120]] },
      { id: 'X-S', component_id: 'CROSS', cad_include: true, topology_network_candidate: false, from: 'X', to: 'S', geometry: [[180,120],[180,270]] }
    ]
  };
  const project = createManualCadProjectFromGraph(graph);
  assert.equal(project.pipes.length, 2);
  const horizontal = project.pipes.find(pipe => pipe.points.every(point => point[1] === 120));
  const vertical = project.pipes.find(pipe => pipe.points.every(point => point[0] === 180));
  assert.ok(horizontal);
  assert.ok(vertical);
  assert.equal(horizontal.reviewOnly, true);
  assert.equal(vertical.reviewOnly, true);
});
