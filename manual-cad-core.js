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
    width: 1600,
    height: 1000,
    page: 'portrait',
    preparedBy: '',
    notes: '',
    pipes: [],
    junctions: [],
    symbols: [],
    labels: [],
    dimensions: []
  };
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
    width,
    height,
    page: input?.page === 'landscape' ? 'landscape' : 'portrait',
    preparedBy: text(input?.preparedBy ?? base.preparedBy, 100),
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
      name: text(raw.name, 80),
      diameter: text(raw.diameter, 32),
      kind: raw.kind === 'branch' ? 'branch' : 'pipe',
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
  const pageW = landscape ? 297 : 210, pageH = landscape ? 210 : 297;
  const area = landscape ? { x: 12, y: 12, w: 273, h: 150 } : { x: 12, y: 12, w: 186, h: 236 };
  const b = collectBounds(project);
  const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
  const scale = Math.min(area.w / bw, area.h / bh);
  const ox = area.x + (area.w - bw * scale) / 2 - b.minX * scale;
  const oy = area.y + (area.h - bh * scale) / 2 - b.minY * scale;
  return { pageW, pageH, area, map: ([x, y]) => [ox + x * scale, oy + y * scale], scale };
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
