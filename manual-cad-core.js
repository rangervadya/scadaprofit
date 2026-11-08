import { randomUUID } from 'node:crypto';

const SYMBOL_TYPES = new Set(['valve', 'meter', 'regulator', 'consumer', 'riser', 'filter']);
const MAX_PIPES = 1200;
const MAX_POINTS_PER_PIPE = 1200;
const MAX_LABELS = 2000;
const MAX_SYMBOLS = 1000;
const MAX_JUNCTIONS = 3000;
const MAX_DIMENSIONS = 1000;

export function isManualCadId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function text(value, max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function point(value, width, height) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = num(value[0], NaN), y = num(value[1], NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [Math.max(0, Math.min(width, x)), Math.max(0, Math.min(height, y))];
}
function safeId(value, prefix) {
  const id = text(value, 64);
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : `${prefix}_${randomUUID()}`;
}

export function createManualCadProject({ id = randomUUID(), title = 'Новая схема' } = {}) {
  const now = new Date().toISOString();
  return {
    schema: 'scadaprofit.manual-cad.v1',
    id,
    title: text(title, 140) || 'Новая схема',
    createdAt: now,
    updatedAt: now,
    source: null,
    sourceJobId: null,
    sourceStreetId: null,
    sourceBuildingId: null,
    analysisComplete: true,
    manualEditRevision: 0,
    width: 1600,
    height: 1000,
    page: 'portrait',
    paperSize: 'A4',
    drawingStyle: 'standard',
    preparedBy: '',
    siteAddress: '',
    entrance: '',
    inspectionTitle: 'Заключение по результатам технического диагностирования внутридомового газового оборудования',
    schemeSubtitle: 'неразрушающего контроля внутридомового газового оборудования',
    schemeAuthor: '',
    schemeChecker: '',
    riserGroups: [],
    notes: '',
    pipes: [],
    junctions: [],
    symbols: [],
    labels: [],
    dimensions: []
  };
}

export function createManualCadProjectFromGraph(graph, { id = randomUUID(), title = 'Черновик схемы', siteAddress = '', entrance = '', sourceJobId = null, sourceStreetId = null, sourceBuildingId = null } = {}) {
  const documentModel = graph?.documentModel && typeof graph.documentModel === 'object' ? graph.documentModel : {};
  const sourceSize = graph?.image || documentModel.sourceImage || {};
  const width = Math.round(Math.max(100, Math.min(30000, num(sourceSize.width, 1600))));
  const height = Math.round(Math.max(100, Math.min(30000, num(sourceSize.height, 1000))));
  const base = createManualCadProject({ id, title });
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  // Only selected CAD paths and explicitly user-confirmed edges are imported.
  // Review-only strokes and crossings are intentionally not promoted.
  const selectedEdges = rawEdges.filter(edge =>
    edge && (edge.cad_include === true || (edge.source === 'manual' && edge.detector === 'MANUAL'))
  );
  const pipes = [];
  const pipeIdsByNode = new Map();
  for (const edge of selectedEdges) {
    const points = (Array.isArray(edge.geometry) ? edge.geometry : [])
      .map(raw => Array.isArray(raw) && raw.length >= 2 ? [num(raw[0], NaN), num(raw[1], NaN)] : null)
      .filter(point => point && point.every(Number.isFinite));
    if (points.length < 2) continue;
    const pipeId = safeId(edge.id, `pipe_${pipes.length + 1}`);
    const edgeKind = ['branch', 'riser'].includes(String(edge.kind || edge.cad_kind || ''))
      ? String(edge.kind || edge.cad_kind) : 'pipe';
    pipes.push({ id: pipeId, name: '', diameter: '', kind: edgeKind, points, visible: true });
    for (const nodeId of [edge.from, edge.to]) {
      if (!nodeId) continue;
      if (!pipeIdsByNode.has(String(nodeId))) pipeIdsByNode.set(String(nodeId), []);
      pipeIdsByNode.get(String(nodeId)).push(pipeId);
    }
  }

  // Qwen routes are added only from the server's separately validated set.
  // Unvalidated semanticRoutes remain review-only and are never promoted here.
  const primarySemanticRoutes = Array.isArray(graph?.primarySemanticRoutes) ? graph.primarySemanticRoutes : [];
  for (const route of primarySemanticRoutes) {
    if (route?.primary_validated === false) continue;
    const points = (Array.isArray(route?.points) ? route.points : [])
      .map(raw => Array.isArray(raw) && raw.length >= 2 ? [num(raw[0], NaN), num(raw[1], NaN)] : null)
      .filter(raw => raw && raw.every(Number.isFinite));
    if (points.length < 2) continue;
    const routeId = safeId(`qwen_${route.id || pipes.length + 1}`, `qwen_${pipes.length + 1}`);
    if (pipes.some(pipe => pipe.id === routeId)) continue;
    pipes.push({
      id: routeId, name: text(route.name || route.label, 80), diameter: '',
      kind: ['branch', 'riser'].includes(String(route.kind || '')) ? String(route.kind) : 'pipe',
      points, visible: true, source: 'qwen-ink-validated'
    });
  }

  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const junctions = [];
  for (const node of rawNodes) {
    const connected = [...new Set(pipeIdsByNode.get(String(node?.id || '')) || [])];
    // A visible junction is created only for a primary node with >=3 connected
    // edges. A geometric line crossing alone never appears in this node map.
    if (node?.review === true || Number(node?.degree || 0) < 3 || connected.length < 2) continue;
    const x = num(node.x, NaN), y = num(node.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    junctions.push({ id: safeId(`junction_${node.id}`, 'junction'), x, y, pipeIds: connected });
  }

  const labels = [];
  const seenLabelIds = new Set();
  const addLabel = (raw, fallbackId) => {
    const bbox = raw?.bbox && typeof raw.bbox === 'object' ? raw.bbox : {};
    const textValue = String(raw?.text ?? raw?.rawText ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    const x = num(raw?.x, num(bbox.x, NaN) + num(bbox.w, 0) / 2);
    const y = num(raw?.y, num(bbox.y, NaN) + num(bbox.h, 0) / 2);
    if (!textValue || textValue.length > 180 || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const labelId = String(raw?.id || fallbackId || `ocr_${labels.length + 1}`);
    if (seenLabelIds.has(labelId)) return;
    seenLabelIds.add(labelId);
    labels.push({ id: safeId(labelId, 'ocr'), text: textValue, x, y, size: 16, rotation: 0, anchor: 'middle' });
  };
  const sourceLabels = Array.isArray(documentModel.labels) ? documentModel.labels : [];
  if (sourceLabels.length) sourceLabels.forEach((label, index) => addLabel(label, `ocr_${index + 1}`));
  else if (Array.isArray(graph?.annotations)) graph.annotations.forEach((label, index) => addLabel(label, `ocr_${index + 1}`));

  // Dimension candidates have a text value but no confirmed measurement
  // endpoints. Preserve the reading as a movable OCR label, never as a made-up
  // dimension line.
  for (const dimension of (Array.isArray(documentModel.dimensions) ? documentModel.dimensions : [])) {
    if (dimension?.sourceAnnotationId && seenLabelIds.has(String(dimension.sourceAnnotationId))) continue;
    if (dimension?.rawText) addLabel({ ...dimension, id: dimension.sourceAnnotationId || dimension.id, text: dimension.rawText }, dimension.id);
  }

  // The current recognizer classifies marks as unknown candidates. Import a
  // symbol only if a future/verified pipeline output supplies an explicit type
  // supported by this editor; do not guess from visual appearance.
  const allowedSymbols = new Set(['valve', 'meter', 'regulator', 'consumer', 'riser', 'filter']);
  const symbols = [];
  for (const raw of (Array.isArray(documentModel.symbols) ? documentModel.symbols : [])) {
    const type = String(raw?.type || '');
    if (!allowedSymbols.has(type) || !['primary', 'confirmed'].includes(String(raw?.state || ''))) continue;
    const bbox = raw?.bbox && typeof raw.bbox === 'object' ? raw.bbox : {};
    const x = num(raw?.x, num(bbox.x, NaN) + num(bbox.w, 0) / 2);
    const y = num(raw?.y, num(bbox.y, NaN) + num(bbox.h, 0) / 2);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    symbols.push({ id: safeId(raw.id, `symbol_${symbols.length + 1}`), type, x, y, rotation: 0, label: '', scale: 1 });
  }

  const incomplete = graph?.complete === false || graph?.analysisStatus === 'incomplete';
  const noteParts = [
    'Автоматический черновик по подготовленному изображению. Геометрия перенесена только из основных CAD-линий и явно подтверждённых соединений.',
    'Пересечения автоматически не соединяются. OCR-подписи не проверены; числовые значения сохранены как текст, не как размеры. Неизвестные символы не классифицированы.',
    incomplete ? 'Исходная автоматическая обработка НЕ ЗАВЕРШЕНА. Восстановление неполное; проверьте и дополните по подложке.' : 'Обработка завершена вычислительно, но чертёж всё равно требует инженерной проверки.'
  ];
  return normalizeManualCadProject({
    ...base, width, height, page: width > height ? 'landscape' : 'portrait',
    paperSize: 'A4', drawingStyle: 'lpgcad-r1',
    siteAddress, entrance, sourceJobId, sourceStreetId, sourceBuildingId,
    analysisComplete: !incomplete, manualEditRevision: 0,
    notes: noteParts.join(' '), pipes, junctions, symbols, labels, dimensions: []
  }, base);
}

export function normalizeManualCadProject(input, existing = null) {
  const base = existing || createManualCadProject({ id: input?.id, title: input?.title });
  const width = Math.round(Math.max(100, Math.min(30000, num(input?.width, base.width || 1600))));
  const height = Math.round(Math.max(100, Math.min(30000, num(input?.height, base.height || 1000))));
  const result = {
    schema: 'scadaprofit.manual-cad.v1',
    id: base.id,
    title: text(input?.title ?? base.title, 140) || 'Новая схема',
    createdAt: base.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: base.source || null,
    sourceJobId: text(input?.sourceJobId ?? base.sourceJobId, 64) || null,
    sourceStreetId: text(input?.sourceStreetId ?? base.sourceStreetId, 64) || null,
    sourceBuildingId: text(input?.sourceBuildingId ?? base.sourceBuildingId, 64) || null,
    analysisComplete: input?.analysisComplete === false ? false : input?.analysisComplete === true ? true : (base.analysisComplete !== false),
    manualEditRevision: Math.max(0, Math.floor(num(input?.manualEditRevision, num(base.manualEditRevision, 0)))),
    width,
    height,
    page: input?.page === 'landscape' ? 'landscape' : 'portrait',
    paperSize: input?.paperSize === 'A3' ? 'A3' : 'A4',
    drawingStyle: input?.drawingStyle === 'lpgcad-r1' ? 'lpgcad-r1' : 'standard',
    preparedBy: text(input?.preparedBy ?? base.preparedBy, 100),
    siteAddress: text(input?.siteAddress ?? base.siteAddress, 240),
    entrance: text(input?.entrance ?? base.entrance, 80),
    inspectionTitle: text(input?.inspectionTitle ?? base.inspectionTitle, 240),
    schemeSubtitle: (() => {
      const subtitle = text(input?.schemeSubtitle ?? base.schemeSubtitle, 240);
      return subtitle === 'Схема неразрушающего контроля внутридомового газового оборудования'
        ? 'неразрушающего контроля внутридомового газового оборудования' : subtitle;
    })(),
    schemeAuthor: text(input?.schemeAuthor ?? base.schemeAuthor, 100),
    schemeChecker: text(input?.schemeChecker ?? base.schemeChecker, 100),
    riserGroups: (Array.isArray(input?.riserGroups) ? input.riserGroups : Array.isArray(base.riserGroups) ? base.riserGroups : []).slice(0, 8).map((group, index) => ({
      id: safeId(group?.id, `riser_group_${index + 1}`),
      name: text(group?.name, 40) || `Стояк ${index + 1}`,
      apartments: (Array.isArray(group?.apartments) ? group.apartments : []).slice(0, 30).map(value => text(value, 24)).filter(Boolean)
    })).filter(group => group.apartments.length),
    notes: text(input?.notes ?? base.notes, 1000),
    pipes: [], junctions: [], symbols: [], labels: [], dimensions: []
  };

  const pipeInput = Array.isArray(input?.pipes) ? input.pipes.slice(0, MAX_PIPES) : [];
  for (const raw of pipeInput) {
    const points = (Array.isArray(raw?.points) ? raw.points : [])
      .slice(0, MAX_POINTS_PER_PIPE)
      .map(p => point(p, width, height)).filter(Boolean);
    if (points.length < 2) continue;
    result.pipes.push({
      id: safeId(raw.id, 'pipe'),
      source: raw.source === 'qwen-ink-validated' ? 'qwen-ink-validated' : undefined,
      name: text(raw.name, 80),
      diameter: text(raw.diameter, 32),
      kind: ['branch', 'riser'].includes(raw.kind) ? raw.kind : 'pipe',
      points,
      visible: raw.visible !== false
    });
  }

  const pipeIds = new Set(result.pipes.map(p => p.id));
  const junctionInput = Array.isArray(input?.junctions) ? input.junctions.slice(0, MAX_JUNCTIONS) : [];
  for (const raw of junctionInput) {
    const p = point([raw?.x, raw?.y], width, height);
    if (!p) continue;
    const pipeList = [...new Set((Array.isArray(raw.pipeIds) ? raw.pipeIds : []).map(String).filter(id => pipeIds.has(id)))];
    if (pipeList.length < 2) continue;
    result.junctions.push({ id: safeId(raw.id, 'j'), x: p[0], y: p[1], pipeIds: pipeList });
  }

  const symbolInput = Array.isArray(input?.symbols) ? input.symbols.slice(0, MAX_SYMBOLS) : [];
  for (const raw of symbolInput) {
    const p = point([raw?.x, raw?.y], width, height);
    const type = String(raw?.type || 'valve');
    if (!p || !SYMBOL_TYPES.has(type)) continue;
    result.symbols.push({
      id: safeId(raw.id, 'sym'), type, x: p[0], y: p[1],
      rotation: ((num(raw.rotation) % 360) + 360) % 360,
      label: text(raw.label, 80), scale: Math.max(0.5, Math.min(4, num(raw.scale, 1)))
    });
  }

  const labelInput = Array.isArray(input?.labels) ? input.labels.slice(0, MAX_LABELS) : [];
  for (const raw of labelInput) {
    const p = point([raw?.x, raw?.y], width, height);
    const value = text(raw?.text, 180);
    if (!p || !value) continue;
    result.labels.push({
      id: safeId(raw.id, 'label'), text: value, x: p[0], y: p[1],
      size: Math.max(8, Math.min(64, num(raw.size, 18))),
      rotation: ((num(raw.rotation) % 360) + 360) % 360,
      anchor: raw.anchor === 'middle' ? 'middle' : 'start'
    });
  }

  const dimInput = Array.isArray(input?.dimensions) ? input.dimensions.slice(0, MAX_DIMENSIONS) : [];
  for (const raw of dimInput) {
    const a = point(raw?.a, width, height), b = point(raw?.b, width, height);
    const value = text(raw?.text, 60);
    if (!a || !b || Math.hypot(a[0] - b[0], a[1] - b[1]) < 1 || !value) continue;
    result.dimensions.push({ id: safeId(raw.id, 'dim'), a, b, text: value });
  }
  return result;
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function fmt(value) { return (Math.round(Number(value) * 1000) / 1000).toString(); }
function collectBounds(project) {
  const pts = [];
  for (const pipe of project.pipes) pts.push(...pipe.points);
  for (const item of project.symbols) pts.push([item.x, item.y]);
  for (const item of project.labels) pts.push([item.x, item.y]);
  for (const item of project.dimensions) pts.push(item.a, item.b);
  if (!pts.length) return { minX: 0, minY: 0, maxX: project.width, maxY: project.height };
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const pad = Math.max(20, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.04);
  return { minX: Math.min(...xs) - pad, minY: Math.min(...ys) - pad, maxX: Math.max(...xs) + pad, maxY: Math.max(...ys) + pad };
}
function pageMap(project) {
  const landscape = project.page === 'landscape';
  const a3 = project.paperSize === 'A3';
  const pageW = a3 ? (landscape ? 420 : 297) : (landscape ? 297 : 210);
  const pageH = a3 ? (landscape ? 297 : 420) : (landscape ? 210 : 297);
  const margin = a3 ? 18 : 12;
  const area = { x: margin, y: margin, w: pageW - margin * 2, h: pageH - margin * 2 - 32 };
  const b = collectBounds(project);
  const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
  const scale = Math.min(area.w / bw, area.h / bh);
  const ox = area.x + (area.w - bw * scale) / 2 - b.minX * scale;
  const oy = area.y + (area.h - bh * scale) / 2 - b.minY * scale;
  return { pageW, pageH, area, map: ([x, y]) => [ox + x * scale, oy + y * scale], scale };
}

function lpgCadPageMap(project) {
  const landscape = project.page === 'landscape';
  const a3 = project.paperSize === 'A3';
  const pageW = a3 ? (landscape ? 420 : 297) : (landscape ? 297 : 210);
  const pageH = a3 ? (landscape ? 297 : 420) : (landscape ? 210 : 297);
  const groups = Array.isArray(project.riserGroups) ? project.riserGroups.filter(group => group.apartments?.length) : [];
  const maxRows = groups.reduce((max, group) => Math.max(max, group.apartments.length), 0);
  const legendY = pageH - 43;
  const riserLayout = groups.length ? {
    x: 10, y: legendY - 5 - Math.max(42, maxRows * 4.7 + 14),
    w: pageW - 20, h: Math.max(42, maxRows * 4.7 + 14), maxRows
  } : null;
  const area = {
    x: landscape ? 12 : 10,
    y: 38,
    w: pageW - (landscape ? 24 : 20),
    h: Math.max(30, (riserLayout ? riserLayout.y - 8 : pageH - 50) - 38)
  };
  const bounds = collectBounds(project);
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(area.w / bw, area.h / bh);
  const ox = area.x + (area.w - bw * scale) / 2 - bounds.minX * scale;
  const oy = area.y + (area.h - bh * scale) / 2 - bounds.minY * scale;
  return {
    pageW, pageH, area, riserLayout, scale,
    map: ([x, y]) => [ox + x * scale, oy + y * scale]
  };
}

function symbolMarkup(symbol, map) {
  const [x, y] = map([symbol.x, symbol.y]);
  const s = Math.max(1.8, Math.min(4.5, 2.4 * symbol.scale));
  const common = `fill="white" stroke="#111" stroke-width="0.42" stroke-linejoin="round" stroke-linecap="round"`;
  let body = '';
  if (symbol.type === 'valve') body = `<path d="M ${-s} ${-s} L 0 0 L ${-s} ${s} Z M ${s} ${-s} L 0 0 L ${s} ${s} Z" ${common}/><path d="M 0 ${-s} V ${-s * 1.65}" stroke="#111" stroke-width="0.35"/>`;
  if (symbol.type === 'meter') body = `<circle r="${s * 1.25}" ${common}/><text y="${s * 0.38}" text-anchor="middle" font-size="${s * 1.05}" fill="#111" stroke="none">G</text>`;
  if (symbol.type === 'regulator') body = `<rect x="${-s * 1.3}" y="${-s}" width="${s * 2.6}" height="${s * 2}" ${common}/><path d="M ${-s} ${s * 0.65} L ${s} ${-s * 0.65}" stroke="#111" stroke-width="0.4"/>`;
  if (symbol.type === 'consumer') body = `<circle r="${s * 1.35}" ${common}/><path d="M 0 ${s} C ${-s * 1.5} ${s * 0.1}, ${s * 0.6} ${-s * 0.3}, 0 ${-s}" fill="none" stroke="#111" stroke-width="0.48"/>`;
  if (symbol.type === 'riser') body = `<path d="M 0 ${s * 1.8} V ${-s * 1.8} M ${-s} ${-s * 1.8} H ${s}" fill="none" stroke="#111" stroke-width="0.55"/>`;
  if (symbol.type === 'filter') body = `<path d="M ${-s * 1.25} ${-s} L ${s * 1.25} ${-s} L ${s * 1.25} ${s} L ${-s * 1.25} ${s} Z" ${common}/><path d="M ${-s} ${s} L ${s} ${-s}" stroke="#111" stroke-width="0.4"/>`;
  return `<g transform="translate(${fmt(x)} ${fmt(y)}) rotate(${fmt(symbol.rotation)})">${body}${symbol.label ? `<text x="0" y="${fmt(s * 2.7)}" text-anchor="middle" font-size="2.1" fill="#111" stroke="none">${esc(symbol.label)}</text>` : ''}</g>`;
}

export function renderManualCadSvg(rawProject) {
  const project = normalizeManualCadProject(rawProject, rawProject);
  if (project.drawingStyle === 'lpgcad-r1') return renderLpgCadR1Svg(project);
  const { pageW, pageH, map } = pageMap(project);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}mm" height="${pageH}mm" viewBox="0 0 ${pageW} ${pageH}">`);
  parts.push('<title>' + esc(project.title) + '</title><rect width="100%" height="100%" fill="#fff"/>');
  parts.push(`<rect x="5" y="5" width="${pageW - 10}" height="${pageH - 10}" fill="none" stroke="#111" stroke-width="0.35"/>`);
  parts.push('<g id="PIPE_MAIN" fill="none" stroke="#111" stroke-width="0.62" stroke-linecap="round" stroke-linejoin="round">');
  for (const pipe of project.pipes) {
    if (pipe.visible === false) continue;
    const points = pipe.points.map(p => map(p).map(fmt).join(',')).join(' ');
    parts.push(`<polyline id="${esc(pipe.id)}" points="${points}"/>`);
  }
  parts.push('</g>');
  parts.push('<g id="JUNCTIONS" fill="#111" stroke="#111" stroke-width="0.25">');
  for (const junction of project.junctions) {
    const [x, y] = map([junction.x, junction.y]);
    parts.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="0.7"/>`);
  }
  parts.push('</g>');
  parts.push('<g id="SYMBOLS">');
  for (const symbol of project.symbols) parts.push(symbolMarkup(symbol, map));
  parts.push('</g>');
  parts.push('<g id="DIMENSIONS" fill="none" stroke="#222" stroke-width="0.28">');
  for (const dim of project.dimensions) {
    const a = map(dim.a), b = map(dim.b);
    parts.push(`<path d="M ${fmt(a[0])} ${fmt(a[1])} L ${fmt(b[0])} ${fmt(b[1])} M ${fmt(a[0] - 1.2)} ${fmt(a[1] - 1.2)} l 2.4 2.4 M ${fmt(b[0] - 1.2)} ${fmt(b[1] - 1.2)} l 2.4 2.4"/>`);
    parts.push(`<text x="${fmt((a[0] + b[0]) / 2)}" y="${fmt((a[1] + b[1]) / 2 - 1.3)}" text-anchor="middle" font-size="2.5" fill="#111" stroke="none">${esc(dim.text)}</text>`);
  }
  parts.push('</g>');
  parts.push('<g id="TEXT" fill="#111" font-family="Arial,sans-serif">');
  for (const label of project.labels) {
    const [x, y] = map([label.x, label.y]);
    parts.push(`<text x="${fmt(x)}" y="${fmt(y)}" font-size="${fmt(Math.max(2, label.size * 0.12))}" text-anchor="${label.anchor}" transform="rotate(${fmt(label.rotation)} ${fmt(x)} ${fmt(y)})">${esc(label.text)}</text>`);
  }
  for (const pipe of project.pipes) {
    if (!pipe.name && !pipe.diameter) continue;
    const p = pipe.points[Math.floor((pipe.points.length - 1) / 2)];
    const [x, y] = map(p);
    const lineText = [pipe.name, pipe.diameter ? `DN ${pipe.diameter}` : ''].filter(Boolean).join(' · ');
    parts.push(`<text x="${fmt(x + 1.5)}" y="${fmt(y - 1.3)}" font-size="2.1">${esc(lineText)}</text>`);
  }
  parts.push('</g>');
  const blockY = pageH - 32;
  parts.push(`<g id="TITLE_BLOCK" fill="none" stroke="#111" stroke-width="0.3"><rect x="5" y="${blockY}" width="${pageW - 10}" height="${pageH - blockY - 5}"/><path d="M ${pageW - 82} ${blockY} V ${pageH - 5} M ${pageW - 42} ${blockY} V ${pageH - 5} M 5 ${blockY + 13} H ${pageW - 5}"/></g>`);
  parts.push(`<g fill="#111" font-family="Arial,sans-serif"><text x="9" y="${blockY + 7}" font-size="3.2" font-weight="bold">${esc(project.title || 'СХЕМА ТРУБОПРОВОДА')}</text><text x="9" y="${blockY + 19}" font-size="2.2">${esc(project.notes || 'Схема восстановлена по исходному эскизу; соединения проверить перед применением.')}</text><text x="${pageW - 78}" y="${blockY + 7}" font-size="2.2">ИСПОЛНИТЕЛЬ</text><text x="${pageW - 78}" y="${blockY + 19}" font-size="2.5">${esc(project.preparedBy || '—')}</text><text x="${pageW - 39}" y="${blockY + 7}" font-size="2.2">ЛИСТ</text><text x="${pageW - 39}" y="${blockY + 19}" font-size="2.5">1 / 1</text></g>`);
  parts.push('</svg>');
  return parts.join('\n');
}

function renderLpgCadR1Svg(project) {
  const { pageW, pageH, area, riserLayout, map } = lpgCadPageMap(project);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}mm" height="${pageH}mm" viewBox="0 0 ${pageW} ${pageH}">`,
    `<title>${esc(project.title || 'Схема газоснабжения')}</title>`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    `<g id="HEADER" fill="#111" font-family="Arial,sans-serif">`,
    `<text x="${fmt(pageW / 2)}" y="5" text-anchor="middle" font-size="2.6">${esc(project.inspectionTitle)}</text>`,
    `<text x="${fmt(pageW - 5)}" y="12" text-anchor="end" font-size="4.2" font-weight="700">ПРОДОЛЖЕНИЕ ПРИЛОЖЕНИЯ</text>`,
    `<text x="${fmt(pageW / 2)}" y="23" text-anchor="middle" font-size="3.6" font-style="italic">Схема</text>`,
    `<text x="${fmt(pageW / 2)}" y="28" text-anchor="middle" font-size="3.0" font-style="italic">${esc(project.schemeSubtitle)}</text>`,
    `<text x="${fmt(pageW / 2)}" y="34" text-anchor="middle" font-size="2.7" font-style="italic">по адресу: ${esc([project.siteAddress, project.entrance ? `подъезд ${project.entrance}` : ''].filter(Boolean).join(', ') || 'адрес не указан')}</text>`,
    '</g>',
    `<rect x="${fmt(area.x)}" y="${fmt(area.y)}" width="${fmt(area.w)}" height="${fmt(area.h)}" fill="none" stroke="#c7c7c7" stroke-width="0.12"/>`,
  ];
  for (const [kind, layer, strokeWidth] of [['pipe','PIPE_MAIN',0.52],['branch','BRANCH',0.48],['riser','RISERS',0.62]]) {
    parts.push(`<g id="${layer}" fill="none" stroke="#111" stroke-width="${fmt(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round">`);
    for (const pipe of project.pipes) {
      if (pipe.visible === false || pipe.kind !== kind) continue;
      const points = pipe.points.map(p => map(p).map(fmt).join(',')).join(' ');
      parts.push(`<polyline id="${esc(pipe.id)}" points="${points}"/>`);
    }
    parts.push('</g>');
  }
  parts.push('<g id="JUNCTIONS" fill="#111" stroke="#111" stroke-width="0.2">');
  for (const junction of project.junctions) {
    const [x, y] = map([junction.x, junction.y]);
    parts.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="0.62"/>`);
  }
  parts.push('</g><g id="SYMBOLS">');
  for (const symbol of project.symbols) parts.push(symbolMarkup(symbol, map));
  parts.push('</g><g id="DIMENSIONS" fill="none" stroke="#222" stroke-width="0.25">');
  for (const dim of project.dimensions) {
    const a = map(dim.a), b = map(dim.b);
    parts.push(`<path d="M ${fmt(a[0])} ${fmt(a[1])} L ${fmt(b[0])} ${fmt(b[1])} M ${fmt(a[0] - 1)} ${fmt(a[1] - 1)} l 2 2 M ${fmt(b[0] - 1)} ${fmt(b[1] - 1)} l 2 2"/>`);
    parts.push(`<text x="${fmt((a[0] + b[0]) / 2)}" y="${fmt((a[1] + b[1]) / 2 - 1.2)}" text-anchor="middle" font-size="2.1" fill="#111" stroke="none">${esc(dim.text)}</text>`);
  }
  parts.push('</g><g id="TEXT" fill="#111" font-family="Arial,sans-serif">');
  for (const label of project.labels) {
    const [x, y] = map([label.x, label.y]);
    parts.push(`<text x="${fmt(x)}" y="${fmt(y)}" font-size="${fmt(Math.max(1.7, label.size * 0.105))}" text-anchor="${label.anchor}" transform="rotate(${fmt(label.rotation)} ${fmt(x)} ${fmt(y)})">${esc(label.text)}</text>`);
  }
  for (const pipe of project.pipes) {
    if (pipe.visible === false || (!pipe.name && !pipe.diameter)) continue;
    const [x, y] = map(pipe.points[Math.floor((pipe.points.length - 1) / 2)]);
    parts.push(`<text x="${fmt(x + 1.2)}" y="${fmt(y - 1.0)}" font-size="1.9">${esc([pipe.name, pipe.diameter ? `DN ${pipe.diameter}` : ''].filter(Boolean).join(' · '))}</text>`);
  }
  parts.push('</g>');

  if (riserLayout) {
    parts.push(`<g id="RISER_GROUPS" font-family="Arial,sans-serif" fill="#111" stroke="#111" stroke-width="0.35">`);
    parts.push(`<rect x="${fmt(riserLayout.x)}" y="${fmt(riserLayout.y)}" width="${fmt(riserLayout.w)}" height="${fmt(riserLayout.h)}" fill="none" stroke="#777" stroke-width="0.2"/>`);
    parts.push(`<text x="${fmt(riserLayout.x + 2)}" y="${fmt(riserLayout.y + 4)}" font-size="2.2" font-weight="700" stroke="none">ГРУППЫ СТОЯКОВ · НОМЕРА КВАРТИР ПО ДАННЫМ ОПЕРАТОРА</text>`);
    const columnW = riserLayout.w / project.riserGroups.length;
    const contentTop = riserLayout.y + 10;
    const contentBottom = riserLayout.y + riserLayout.h - 3;
    const rowStep = (contentBottom - contentTop) / Math.max(1, riserLayout.maxRows);
    project.riserGroups.forEach((group, groupIndex) => {
      const left = riserLayout.x + groupIndex * columnW;
      const center = left + columnW / 2;
      const labelWidth = Math.min(13, columnW * 0.38);
      parts.push(`<text x="${fmt(center)}" y="${fmt(riserLayout.y + 8)}" text-anchor="middle" font-size="2.1" font-weight="700" stroke="none">${esc(group.name)}</text>`);
      parts.push(`<path d="M ${fmt(center)} ${fmt(contentTop)} V ${fmt(contentBottom)}" fill="none" stroke-width="0.48"/>`);
      if (groupIndex > 0) parts.push(`<path d="M ${fmt(left)} ${fmt(riserLayout.y + 6)} V ${fmt(contentBottom)}" fill="none" stroke="#bbb" stroke-width="0.12"/>`);
      group.apartments.forEach((apartment, apartmentIndex) => {
        const y = contentTop + rowStep * (apartmentIndex + 0.5);
        const leftSide = apartmentIndex % 2 === 0;
        const boxX = leftSide ? center - labelWidth - 2 : center + 2;
        const branchEnd = leftSide ? boxX + labelWidth : boxX;
        const boxH = Math.min(3.4, Math.max(2.2, rowStep * 0.72));
        const fontSize = Math.min(2.0, Math.max(1.25, rowStep * 0.43));
        parts.push(`<path d="M ${fmt(center)} ${fmt(y)} H ${fmt(branchEnd)}" fill="none" stroke-width="0.3"/>`);
        parts.push(`<circle cx="${fmt(center)}" cy="${fmt(y)}" r="0.62" fill="#fff" stroke-width="0.35"/>`);
        parts.push(`<rect x="${fmt(boxX)}" y="${fmt(y - boxH / 2)}" width="${fmt(labelWidth)}" height="${fmt(boxH)}" fill="#fff" stroke-width="0.25"/>`);
        parts.push(`<text x="${fmt(boxX + labelWidth / 2)}" y="${fmt(y + fontSize * 0.32)}" text-anchor="middle" font-size="${fmt(fontSize)}" stroke="none">${esc(apartment)}</text>`);
      });
    });
    parts.push('</g>');
  }

  const legendX = pageW - (project.page === 'landscape' ? 112 : 82);
  const legendY = pageH - 43;
  parts.push(`<g id="LEGEND" font-family="Arial,sans-serif" fill="#111" stroke="#111" stroke-width="0.2"><rect x="${fmt(legendX)}" y="${fmt(legendY)}" width="${fmt(pageW - legendX - 6)}" height="31" fill="none"/>`);
  parts.push(`<text x="${fmt(legendX + 2)}" y="${fmt(legendY + 4)}" font-size="2.1" font-weight="700" stroke="none">УСЛОВНЫЕ ОБОЗНАЧЕНИЯ</text>`);
  const legendRows = [
    ['line', 'расположение контролируемого участка'],
    ['number', 'номер контролируемого участка'],
    ['junction', 'узел соединения трубопровода'],
    ['riser', 'стояк / вертикальный участок']
  ];
  legendRows.forEach(([kind, label], index) => {
    const y = legendY + 8 + index * 5.1;
    if (kind === 'line') parts.push(`<path d="M ${fmt(legendX + 2)} ${fmt(y)} h 7"/>`);
    if (kind === 'number') parts.push(`<rect x="${fmt(legendX + 3)}" y="${fmt(y - 2)}" width="5" height="3.5" fill="#fff"/><text x="${fmt(legendX + 5.5)}" y="${fmt(y + 0.5)}" text-anchor="middle" font-size="2" stroke="none">1</text>`);
    if (kind === 'junction') parts.push(`<circle cx="${fmt(legendX + 5.5)}" cy="${fmt(y - 0.3)}" r="1"/>`);
    if (kind === 'riser') parts.push(`<path d="M ${fmt(legendX + 5.5)} ${fmt(y - 2)} v 4 m -1.5 -4 h 3"/>`);
    parts.push(`<text x="${fmt(legendX + 11)}" y="${fmt(y + 0.6)}" font-size="1.85" stroke="none">${esc(label)}</text>`);
  });
  parts.push('</g>');

  if (project.notes) {
    parts.push(`<text x="10" y="${fmt(pageH - 22)}" font-family="Arial,sans-serif" font-size="1.9" fill="#333">Примечание: ${esc(project.notes)}</text>`);
  }

  const signY = pageH - 7;
  parts.push(`<g id="SIGNATURES" font-family="Arial,sans-serif" fill="#111" font-size="2.3">`);
  parts.push(`<text x="10" y="${fmt(signY - 8)}">Схему составил: ${esc(project.schemeAuthor || project.preparedBy || '________________')}</text>`);
  parts.push(`<text x="10" y="${fmt(signY - 3)}">Схему начертил: ${esc(project.schemeChecker || '________________')}</text>`);
  parts.push(`<text x="${fmt(pageW - 6)}" y="${fmt(signY - 3)}" text-anchor="end">Лист 1 / 1</text>`);
  parts.push('</g></svg>');
  return parts.join('\n');
}

function dxfPair(code, value) { return `${code}\n${value}`; }
function dxfNumber(value) { return fmt(value); }
function addDxfLine(out, layer, a, b) {
  out.push('0','LINE','8',layer,'10',dxfNumber(a[0]),'20',dxfNumber(a[1]),'30','0','11',dxfNumber(b[0]),'21',dxfNumber(b[1]),'31','0');
}
function escapeDxfText(value) {
  return String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 180).replace(/[^\x20-\x7E]/g, char => {
    const code = char.codePointAt(0);
    if (code <= 0xFFFF) return `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    const adjusted = code - 0x10000;
    const high = 0xD800 + (adjusted >> 10), low = 0xDC00 + (adjusted & 0x3FF);
    return `\\U+${high.toString(16).toUpperCase()}\\U+${low.toString(16).toUpperCase()}`;
  });
}
function addDxfText(out, layer, value, p, height = 2.5) {
  out.push('0','TEXT','8',layer,'10',dxfNumber(p[0]),'20',dxfNumber(p[1]),'30','0','40',dxfNumber(height),'1',escapeDxfText(value));
}
function addDxfCircle(out, layer, p, radius) {
  out.push('0','CIRCLE','8',layer,'10',dxfNumber(p[0]),'20',dxfNumber(p[1]),'30','0','40',dxfNumber(radius));
}

export function renderManualCadDxf(rawProject) {
  const project = normalizeManualCadProject(rawProject, rawProject);
  if (project.drawingStyle === 'lpgcad-r1') return renderLpgCadR1Dxf(project);
  const { pageW, pageH, map } = pageMap(project);
  const dxfPoint = p => { const mapped = map(p); return [mapped[0], pageH - mapped[1]]; };
  const out = ['0','SECTION','2','HEADER','9','$ACADVER','1','AC1015','9','$INSUNITS','70','4','9','$DWGCODEPAGE','3','ANSI_1251','0','ENDSEC','0','SECTION','2','TABLES','0','TABLE','2','LAYER','70','6'];
  for (const [name, color] of [['PIPE_MAIN',7],['JUNCTIONS',7],['SYMBOLS',7],['TEXT',7],['DIMENSIONS',7],['TITLE_BLOCK',8]]) {
    out.push('0','LAYER','2',name,'70','0','62',String(color),'6','CONTINUOUS');
  }
  out.push('0','ENDTAB','0','ENDSEC','0','SECTION','2','ENTITIES');
  for (const pipe of project.pipes) {
    if (pipe.visible === false) continue;
    for (let i = 1; i < pipe.points.length; i++) addDxfLine(out, 'PIPE_MAIN', dxfPoint(pipe.points[i - 1]), dxfPoint(pipe.points[i]));
    if (pipe.name || pipe.diameter) {
      const p = dxfPoint(pipe.points[Math.floor((pipe.points.length - 1) / 2)]);
      addDxfText(out, 'TEXT', [pipe.name, pipe.diameter ? `DN ${pipe.diameter}` : ''].filter(Boolean).join(' / '), p, 2.2);
    }
  }
  for (const junction of project.junctions) addDxfCircle(out, 'JUNCTIONS', dxfPoint([junction.x, junction.y]), 0.7);
  for (const symbol of project.symbols) {
    const p = dxfPoint([symbol.x, symbol.y]);
    const s = 2.4 * symbol.scale;
    if (symbol.type === 'meter' || symbol.type === 'consumer') addDxfCircle(out, 'SYMBOLS', p, s * (symbol.type === 'meter' ? 1.25 : 1.35));
    else {
      addDxfLine(out, 'SYMBOLS', [p[0] - s, p[1] - s], [p[0] + s, p[1] + s]);
      addDxfLine(out, 'SYMBOLS', [p[0] - s, p[1] + s], [p[0] + s, p[1] - s]);
    }
    if (symbol.label) addDxfText(out, 'TEXT', symbol.label, [p[0] + s * 1.6, p[1] + s * 1.6], 2);
  }
  for (const label of project.labels) {
    const p = dxfPoint([label.x, label.y]);
    addDxfText(out, 'TEXT', label.text, p, Math.max(2, label.size * 0.12));
  }
  for (const dim of project.dimensions) {
    const a = dxfPoint(dim.a), b = dxfPoint(dim.b);
    addDxfLine(out, 'DIMENSIONS', a, b);
    addDxfText(out, 'DIMENSIONS', dim.text, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 1.5], 2.3);
  }
  // A4 frame and bottom title block in DXF's upward-positive coordinate system.
  addDxfLine(out, 'TITLE_BLOCK', [5, 5], [pageW - 5, 5]);
  addDxfLine(out, 'TITLE_BLOCK', [pageW - 5, 5], [pageW - 5, pageH - 5]);
  addDxfLine(out, 'TITLE_BLOCK', [pageW - 5, pageH - 5], [5, pageH - 5]);
  addDxfLine(out, 'TITLE_BLOCK', [5, pageH - 5], [5, 5]);
  addDxfLine(out, 'TITLE_BLOCK', [5, 32], [pageW - 5, 32]);
  addDxfLine(out, 'TITLE_BLOCK', [pageW - 82, 5], [pageW - 82, 32]);
  addDxfLine(out, 'TITLE_BLOCK', [pageW - 42, 5], [pageW - 42, 32]);
  addDxfLine(out, 'TITLE_BLOCK', [5, 18], [pageW - 5, 18]);
  addDxfText(out, 'TITLE_BLOCK', project.title || 'СХЕМА ТРУБОПРОВОДА', [9, 25], 3.2);
  addDxfText(out, 'TITLE_BLOCK', project.notes || 'Схема восстановлена по эскизу; проверить перед применением.', [9, 11], 2.0);
  addDxfText(out, 'TITLE_BLOCK', 'ИСПОЛНИТЕЛЬ', [pageW - 78, 25], 2.0);
  addDxfText(out, 'TITLE_BLOCK', project.preparedBy || '—', [pageW - 78, 11], 2.2);
  addDxfText(out, 'TITLE_BLOCK', 'ЛИСТ', [pageW - 39, 25], 2.0);
  addDxfText(out, 'TITLE_BLOCK', '1 / 1', [pageW - 39, 11], 2.2);
  out.push('0','ENDSEC','0','EOF');
  return out.join('\n') + '\n';
}

function renderLpgCadR1Dxf(project) {
  const { pageW, pageH, map, area, riserLayout } = lpgCadPageMap(project);
  const toDxf = p => { const mapped = map(p); return [mapped[0], pageH - mapped[1]]; };
  const out = ['0','SECTION','2','HEADER','9','$ACADVER','1','AC1015','9','$INSUNITS','70','4','9','$DWGCODEPAGE','3','ANSI_1251','0','ENDSEC','0','SECTION','2','TABLES','0','TABLE','2','LAYER','70','12'];
  for (const [name, color] of [['SHEET',8],['PIPE_MAIN',7],['BRANCH',7],['RISERS',7],['RISER_GROUPS',7],['JUNCTIONS',7],['SYMBOLS',7],['TEXT',7],['DIMENSIONS',7],['HEADER',7],['LEGEND',7],['SIGNATURES',7]]) {
    out.push('0','LAYER','2',name,'70','0','62',String(color),'6','CONTINUOUS');
  }
  out.push('0','ENDTAB','0','ENDSEC','0','SECTION','2','ENTITIES');
  const addPolyline = (layer, points, closed = false) => {
    if (points.length < 2) return;
    out.push('0','LWPOLYLINE','100','AcDbEntity','8',layer,'100','AcDbPolyline','90',String(points.length),'70',closed ? '1' : '0');
    for (const p of points) { const q = [p[0], pageH - p[1]]; out.push('10',fmt(q[0]),'20',fmt(q[1])); }
  };
  addPolyline('SHEET', [[5,5],[pageW-5,5],[pageW-5,pageH-5],[5,pageH-5]], true);
  addPolyline('SHEET', [[area.x,area.y],[area.x+area.w,area.y],[area.x+area.w,area.y+area.h],[area.x,area.y+area.h]], true);
  const addTextAtPage = (layer, value, p, height = 2.4) => addDxfText(out, layer, value, [p[0], pageH - p[1]], height);
  for (const pipe of project.pipes) {
    if (pipe.visible === false) continue;
    const layer = pipe.kind === 'riser' ? 'RISERS' : pipe.kind === 'branch' ? 'BRANCH' : 'PIPE_MAIN';
    const points = pipe.points.map(toDxf);
    for (let i = 1; i < points.length; i++) addDxfLine(out, layer, points[i - 1], points[i]);
    if (pipe.name || pipe.diameter) {
      const p = points[Math.floor((points.length - 1) / 2)];
      addDxfText(out, 'TEXT', [pipe.name, pipe.diameter ? `DN ${pipe.diameter}` : ''].filter(Boolean).join(' · '), [p[0] + 1, p[1] + 1], 1.8);
    }
  }
  if (riserLayout) {
    const top = riserLayout.y, bottom = riserLayout.y + riserLayout.h, right = riserLayout.x + riserLayout.w;
    addPolyline('RISER_GROUPS', [[riserLayout.x,top],[right,top],[right,bottom],[riserLayout.x,bottom]], true);
    addTextAtPage('RISER_GROUPS','ГРУППЫ СТОЯКОВ - НОМЕРА КВАРТИР ПО ДАННЫМ ОПЕРАТОРА',[riserLayout.x+2,top+4],1.8);
    const columnW=riserLayout.w/project.riserGroups.length;
    const contentTop=top+10, contentBottom=bottom-3;
    const rowStep=(contentBottom-contentTop)/Math.max(1,riserLayout.maxRows);
    project.riserGroups.forEach((group,groupIndex)=>{
      const left=riserLayout.x+groupIndex*columnW, center=left+columnW/2;
      const labelWidth=Math.min(13,columnW*.38);
      addTextAtPage('RISER_GROUPS',group.name,[center,top+8],1.8);
      addDxfLine(out,'RISER_GROUPS',[center,pageH-contentTop],[center,pageH-contentBottom]);
      if(groupIndex>0) addDxfLine(out,'RISER_GROUPS',[left,pageH-(top+6)],[left,pageH-contentBottom]);
      group.apartments.forEach((apartment,apartmentIndex)=>{
        const y=contentTop+rowStep*(apartmentIndex+.5), leftSide=apartmentIndex%2===0;
        const boxX=leftSide?center-labelWidth-2:center+2, branchEnd=leftSide?boxX+labelWidth:boxX;
        const boxH=Math.min(3.4,Math.max(2.2,rowStep*.72));
        addDxfLine(out,'RISER_GROUPS',[center,pageH-y],[branchEnd,pageH-y]);
        addDxfCircle(out,'RISER_GROUPS',[center,pageH-y],.62);
        addPolyline('RISER_GROUPS',[[boxX,y-boxH/2],[boxX+labelWidth,y-boxH/2],[boxX+labelWidth,y+boxH/2],[boxX,y+boxH/2]],true);
        addTextAtPage('RISER_GROUPS',apartment,[boxX+labelWidth/2,y+0.6],Math.min(2,Math.max(1.25,rowStep*.43)));
      });
    });
  }
  for (const junction of project.junctions) addDxfCircle(out, 'JUNCTIONS', toDxf([junction.x, junction.y]), 0.65);
  for (const symbol of project.symbols) {
    const p = toDxf([symbol.x, symbol.y]), s = 2.2 * symbol.scale;
    if (['meter','consumer'].includes(symbol.type)) addDxfCircle(out, 'SYMBOLS', p, s * 1.15);
    else {
      addDxfLine(out, 'SYMBOLS', [p[0]-s,p[1]-s], [p[0]+s,p[1]+s]);
      addDxfLine(out, 'SYMBOLS', [p[0]-s,p[1]+s], [p[0]+s,p[1]-s]);
    }
    if (symbol.label) addDxfText(out, 'TEXT', symbol.label, [p[0]+s*1.5,p[1]+s*1.5], 1.8);
  }
  for (const label of project.labels) addDxfText(out, 'TEXT', label.text, toDxf([label.x,label.y]), Math.max(1.8,label.size*0.105));
  for (const dim of project.dimensions) {
    const a=toDxf(dim.a), b=toDxf(dim.b); addDxfLine(out,'DIMENSIONS',a,b);
    addDxfText(out,'DIMENSIONS',dim.text,[(a[0]+b[0])/2,(a[1]+b[1])/2+1],2);
  }
  addTextAtPage('HEADER', project.inspectionTitle, [pageW/2,5], 2.4);
  addTextAtPage('HEADER', 'ПРОДОЛЖЕНИЕ ПРИЛОЖЕНИЯ', [pageW-7,12], 3.6);
  addTextAtPage('HEADER', 'СХЕМА', [pageW/2,23], 3.0);
  addTextAtPage('HEADER', project.schemeSubtitle, [pageW/2,28], 2.4);
  addTextAtPage('HEADER', `по адресу: ${[project.siteAddress, project.entrance ? `подъезд ${project.entrance}` : ''].filter(Boolean).join(', ') || 'адрес не указан'}`, [pageW/2,34], 2.2);
  const lx=pageW-(project.page==='landscape'?112:82), ly=pageH-43;
  addPolyline('LEGEND',[[lx,ly],[pageW-6,ly],[pageW-6,ly+31],[lx,ly+31]],true);
  addTextAtPage('LEGEND','УСЛОВНЫЕ ОБОЗНАЧЕНИЯ',[lx+2,ly+4],1.8);
  const legendLabels=['расположение контролируемого участка','номер контролируемого участка','узел соединения трубопровода','стояк / вертикальный участок'];
  legendLabels.forEach((label,i)=>addTextAtPage('LEGEND',label,[lx+11,ly+8+i*5.1],1.6));
  addDxfLine(out,'LEGEND',[lx+2,pageH-(ly+8)],[lx+9,pageH-(ly+8)]);
  addDxfCircle(out,'LEGEND',[lx+5.5,pageH-(ly+13.1)],0.8);
  addDxfLine(out,'LEGEND',[lx+5.5,pageH-(ly+21.2)],[lx+5.5,pageH-(ly+17.2)]);
  addTextAtPage('SIGNATURES',`Схему составил: ${project.schemeAuthor || project.preparedBy || '________________'}`,[10,pageH-15],2.0);
  addTextAtPage('SIGNATURES',`Схему начертил: ${project.schemeChecker || '________________'}`,[10,pageH-10],2.0);
  addTextAtPage('SIGNATURES','Лист 1 / 1',[pageW-6,pageH-10],2.0);
  if (project.notes) addTextAtPage('SIGNATURES',`Примечание: ${project.notes}`,[10,pageH-22],1.7);
  out.push('0','ENDSEC','0','EOF');
  return out.join('\n')+'\n';
}
