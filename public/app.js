'use strict';
const $ = (id) => document.getElementById(id);

let selectedFile = null;
let previewUrl = null;
let graph = null;
let connectMode = false;
let firstNode = null;
let draggingNode = null;
let showAllSegments = false;
let edgePage = 1;
const EDGE_PAGE_SIZE = 140;

const fileInput = $('fileInput');
const dropzone = $('dropzone');
const analyzeBtn = $('analyzeBtn');

function setAlert(message = '') {
  const box = $('inlineError');
  box.textContent = message;
  box.hidden = !message;
}
function setState(text, kind = 'ready') {
  $('analysisState').textContent = text;
  const dot = document.querySelector('.live-status i');
  if (dot) dot.style.background = kind === 'error' ? '#c95c52' : kind === 'busy' ? '#e58c48' : '#55b38e';
}
function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}
function supportedImage(file) {
  const nameOk = /\.(jpe?g|png|webp|tiff?)$/i.test(file.name || '');
  const mimeOk = /^image\/(jpeg|png|webp|tiff)$/.test(file.type || '');
  return nameOk || mimeOk;
}

fileInput.addEventListener('change', () => setFile(fileInput.files?.[0]));
for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    dropzone.classList.add('over');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    dropzone.classList.remove('over');
  });
}
dropzone.addEventListener('drop', event => setFile(event.dataTransfer?.files?.[0]));

function setFile(file) {
  if (!file) return;
  setAlert('');
  if (!supportedImage(file)) {
    setAlert('Формат файла не поддерживается. Выбери JPG, PNG, WEBP или TIFF.');
    return;
  }
  if (file.size > 18 * 1024 * 1024) {
    setAlert('Файл больше 18 МБ. Уменьши изображение или сохрани его в JPG.');
    return;
  }
  selectedFile = file;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  $('fileName').textContent = file.name;
  $('previewName').textContent = file.name;
  $('previewMeta').textContent = `${formatBytes(file.size)} · готов к обработке`;
  $('previewThumb').onerror = () => { $('previewThumb').hidden = true; $('previewFallback').style.display = 'grid'; };
  $('previewThumb').onload = () => { $('previewThumb').hidden = false; $('previewFallback').style.display = 'none'; };
  $('previewThumb').src = previewUrl;
  $('previewThumb').hidden = false;
  $('filePreview').hidden = false;
  analyzeBtn.disabled = false;
  graph = null;
  $('statsPanel').hidden = true;
  $('edgePanel').hidden = true;
  $('nodePanel').hidden = true;
  $('textPanel').hidden = true;
  $('sourceEmpty').hidden = false;
  $('imageFrame').hidden = true;
  $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><div class="empty-art blue"><span>CAD</span></div><b>Фото загружено — схема ещё не построена</b><span>Нажми «Найти линии и построить граф».</span></div>';
  $('canvasMeta').textContent = `${file.name} · ${formatBytes(file.size)}`;
  $('previewMeta').textContent = `${formatBytes(file.size)} · готов к обработке`;
  setState('ФОТО ЗАГРУЖЕНО');
}

$('clearFile').addEventListener('click', () => {
  selectedFile = null;
  graph = null;
  fileInput.value = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('filePreview').hidden = true;
  $('fileName').textContent = 'Перетащи фото сюда';
  analyzeBtn.disabled = true;
  $('sourceEmpty').hidden = false;
  $('imageFrame').hidden = true;
  $('statsPanel').hidden = true;
  $('edgePanel').hidden = true;
  $('nodePanel').hidden = true;
  $('textPanel').hidden = true;
  $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><div class="empty-art blue"><span>CAD</span></div><b>Векторный лист пока пуст</b><span>После анализа здесь появится предварительная CAD-схема.</span></div>';
  $('canvasMeta').textContent = 'Ожидает изображения';
  setAlert('');
  setState('ГОТОВ К РАБОТЕ');
});

analyzeBtn.addEventListener('click', async () => {
  if (!selectedFile || analyzeBtn.disabled) return;
  setAlert('');
  analyzeBtn.disabled = true;
  $('progressWrap').hidden = false;
  $('progressLabel').textContent = 'Нормализация фотографии и поиск линий…';
  $('progressPercent').textContent = 'В РАБОТЕ';
  analyzeBtn.querySelector('span:nth-child(2)').textContent = 'Анализирую изображение…';
  setState('АНАЛИЗ ИЗОБРАЖЕНИЯ', 'busy');
  $('previewMeta').textContent = 'Выполняется анализ…';
  try {
    const form = new FormData();
    form.append('image', selectedFile, selectedFile.name);
    const response = await fetch('/api/analyze', { method: 'POST', body: form });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : { error: await response.text() };
    if (!response.ok) throw new Error(data.details || data.error || `Ошибка сервера ${response.status}`);
    if (!data.image || !Array.isArray(data.edges) || !Array.isArray(data.nodes)) {
      throw new Error('Сервер вернул неполный граф. Посмотри журнал приложения.');
    }
    graph = data;
    graph.annotations = Array.isArray(graph.annotations) ? graph.annotations : [];
    graph.crossings = Array.isArray(graph.crossings) ? graph.crossings : [];
    graph.joinCandidates = Array.isArray(graph.joinCandidates) ? graph.joinCandidates : [];
    graph.warnings = Array.isArray(graph.warnings) ? graph.warnings : [];
    graph.edges.forEach(edge => { if (edge.visible === undefined) edge.visible = true; });
    showAllSegments = false;
    connectMode = false;
    firstNode = null;
    edgePage = 1;
    showResult();
  } catch (error) {
    console.error('Analysis failed', error);
    setAlert(`Не удалось обработать изображение: ${error.message}`);
    $('previewMeta').textContent = 'Обработка не завершилась';
    setState('ОШИБКА АНАЛИЗА', 'error');
  } finally {
    $('progressWrap').hidden = true;
    analyzeBtn.disabled = !selectedFile;
    analyzeBtn.querySelector('span:nth-child(2)').textContent = 'Найти линии и построить граф';
  }
});

function showResult() {
  $('statsPanel').hidden = false;
  $('edgePanel').hidden = false;
  $('nodePanel').hidden = false;
  $('textPanel').hidden = false;
  $('sourceEmpty').hidden = true;
  $('imageFrame').hidden = false;
  $('sourceImage').onload = () => fitImageFrame();
  $('sourceImage').onerror = () => {
    setAlert('Граф построен, но сервер не отдал исходное изображение для просмотра.');
  };
  $('sourceImage').src = `${graph.sourceUrl}?v=${Date.now()}`;
  $('canvasMeta').textContent = `${graph.image.width} × ${graph.image.height} px · исходная геометрия сохранена`;
  $('previewMeta').textContent = 'Анализ завершён · можно редактировать';
  $('statusline').textContent = graph.warnings.join(' ');
  const summary = graph.summary || {};
  const stats = [
    [summary.segment_candidates ?? graph.edges.length, 'отрезков-кандидатов'],
    [summary.nodes ?? graph.nodes.length, 'узлов графа'],
    [summary.edges ?? graph.edges.length, 'связей'],
    [summary.crossings_to_review ?? graph.crossings.length, 'пересечений на проверку'],
    [summary.ocr_annotations ?? graph.annotations.length, 'OCR-подписей'],
    [summary.line_components ?? 0, 'линейных компонентов']
  ];
  $('stats').innerHTML = stats.map(([value, label]) => `<div class="stat"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`).join('');
  $('edgeCount').textContent = graph.edges.length.toLocaleString('ru-RU');
  $('nodeCount').textContent = graph.nodes.length.toLocaleString('ru-RU');
  $('textCount').textContent = graph.annotations.filter(a => a.source === 'tesseract').length.toLocaleString('ru-RU');
  renderOverlay();
  renderClean();
  renderEdgeList();
  renderNodeList();
  renderTextList();
  renderJoinList();
  for (const id of ['exportSvg', 'exportDxf', 'exportJson', 'exportPdf']) $(id).disabled = false;
  setState('ГРАФ ПОСТРОЕН · НУЖНА ПРОВЕРКА');
  document.querySelectorAll('.flow-step').forEach((el, index) => el.classList.toggle('active', index < 3));
}

function fitImageFrame() {
  if (!graph || $('imageFrame').hidden) return;
  const stage = $('sourceStage');
  const ratio = graph.image.width / graph.image.height;
  const availableWidth = Math.max(120, stage.clientWidth - 34);
  const availableHeight = Math.max(160, Math.min(window.innerHeight * 0.68, 700) - 10);
  const width = Math.min(availableWidth, availableHeight * ratio);
  $('imageFrame').style.width = `${Math.round(width)}px`;
  $('imageFrame').style.height = `${Math.round(width / ratio)}px`;
}
window.addEventListener('resize', fitImageFrame);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function edgeLength(edge) {
  const points = edge.geometry || [];
  if (points.length < 2) return 0;
  return Math.hypot(points.at(-1)[0] - points[0][0], points.at(-1)[1] - points[0][1]);
}
function shownEdges() {
  return graph.edges.filter(edge => edge.visible !== false && (
    edge.source === 'manual' || showAllSegments || (edgeLength(edge) >= 28 && edge.component_role === 'line_structure')
  ));
}
function lineColor(edge) {
  if (edge.source === 'manual') return '#ca5f54';
  return edge.detector === 'HOUGH' ? '#168e70' : '#e28a42';
}
function renderOverlay() {
  if (!graph) return;
  const visible = shownEdges();
  const lines = visible.map(edge => {
    const points = (edge.geometry || []).map(point => `${Number(point[0]).toFixed(2)},${Number(point[1]).toFixed(2)}`).join(' ');
    if (!points) return '';
    return `<polyline data-edge="${escapeHtml(edge.id)}" points="${points}" fill="none" stroke="${lineColor(edge)}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity=".94"/>`;
  }).join('');
  const nodes = $('showNodes').checked ? graph.nodes.map(node => `
    <g class="node" data-node="${escapeHtml(node.id)}">
      <circle cx="${node.x}" cy="${node.y}" r="${node.degree >= 3 ? 6.2 : 4.4}" fill="#fff" stroke="${nodeSelected(node.id) ? '#e58c48' : '#ca5f54'}" stroke-width="2.1"/>
      <text x="${node.x + 8}" y="${node.y - 8}" font-size="10" fill="#20323a" stroke="#fff" stroke-width="3" paint-order="stroke">${escapeHtml(node.id)}</text>
    </g>`).join('') : '';
  const crossings = $('showCrossings').checked ? graph.crossings.map(crossing => `
    <g><circle cx="${crossing.x}" cy="${crossing.y}" r="8" fill="none" stroke="#9a71b5" stroke-width="2" stroke-dasharray="3 2"/><text x="${crossing.x + 9}" y="${crossing.y - 7}" font-size="10" fill="#80519b" stroke="#fff" stroke-width="2.5" paint-order="stroke">?</text></g>`).join('') : '';
  const overlay = $('overlay');
  overlay.setAttribute('viewBox', `0 0 ${graph.image.width} ${graph.image.height}`);
  overlay.setAttribute('preserveAspectRatio', 'none');
  overlay.innerHTML = lines + crossings + nodes;
  overlay.querySelectorAll('.node').forEach(group => {
    group.addEventListener('pointerdown', event => startNodeAction(event, group.dataset.node));
    group.addEventListener('click', event => {
      event.stopPropagation();
      if (connectMode) chooseNode(group.dataset.node);
      else selectNode(group.dataset.node);
    });
  });
}
function nodeSelected(id) { return connectMode && firstNode === id; }
function selectNode(id) {
  $('selectMode').textContent = `Выбран узел ${id}`;
  document.querySelectorAll('#nodeList .rowitem').forEach(row => row.classList.toggle('selected', row.dataset.node === id));
}
function startNodeAction(event, id) {
  if (connectMode || event.button !== 0) return;
  draggingNode = id;
  $('overlay').setPointerCapture?.(event.pointerId);
  event.preventDefault();
}
$('overlay').addEventListener('pointermove', event => {
  if (!draggingNode || !graph) return;
  const svg = $('overlay');
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const mapped = point.matrixTransform(svg.getScreenCTM().inverse());
  moveNode(draggingNode, Math.max(0, Math.min(graph.image.width, mapped.x)), Math.max(0, Math.min(graph.image.height, mapped.y)));
});
$('overlay').addEventListener('pointerup', () => { draggingNode = null; });
$('overlay').addEventListener('pointercancel', () => { draggingNode = null; });
function moveNode(id, x, y) {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) return;
  node.x = Number(x.toFixed(1));
  node.y = Number(y.toFixed(1));
  for (const edge of graph.edges) {
    if (edge.from === id && edge.geometry?.length) edge.geometry[0] = [node.x, node.y];
    if (edge.to === id && edge.geometry?.length) edge.geometry[edge.geometry.length - 1] = [node.x, node.y];
  }
  renderOverlay();
  renderClean();
  renderNodeList();
}

function renderEdgeList() {
  const query = ($('edgeSearch').value || '').trim().toLowerCase();
  const filtered = graph.edges.filter(edge => !query || [edge.id, edge.detector, edge.component_id, edge.from, edge.to].some(value => String(value || '').toLowerCase().includes(query)));
  const visiblePage = filtered.slice(0, edgePage * EDGE_PAGE_SIZE);
  $('edgeList').innerHTML = visiblePage.map(edge => `
    <label class="rowitem"><input type="checkbox" data-toggle-edge="${escapeHtml(edge.id)}" ${edge.visible === false ? '' : 'checked'}>
      <span class="id">${escapeHtml(edge.id)}</span>
      <span class="meta">${edgeLength(edge).toFixed(0)} px · ${escapeHtml(edge.detector || 'MANUAL')} · ${escapeHtml(edge.component_id || '')}</span>
      <span class="mini">${Math.round((edge.confidence || 0) * 100)}%</span>
    </label>`).join('') || '<div class="helper">По этому запросу линий не найдено.</div>';
  $('edgeMore').hidden = visiblePage.length >= filtered.length;
  $('edgeMore').textContent = `Показать ещё (${Math.min(EDGE_PAGE_SIZE, filtered.length - visiblePage.length)})`;
  $('edgeList').querySelectorAll('[data-toggle-edge]').forEach(input => input.addEventListener('change', () => {
    const edge = graph.edges.find(item => item.id === input.dataset.toggleEdge);
    if (edge) edge.visible = input.checked;
    renderOverlay();
    renderClean();
  }));
}
$('edgeSearch').addEventListener('input', () => { edgePage = 1; renderEdgeList(); });
$('edgeMore').addEventListener('click', () => { edgePage++; renderEdgeList(); });
$('allEdges').addEventListener('click', () => { showAllSegments = true; renderOverlay(); renderClean(); });
$('longEdges').addEventListener('click', () => { showAllSegments = false; renderOverlay(); renderClean(); });
$('showNodes').addEventListener('change', renderOverlay);
$('showCrossings').addEventListener('change', renderOverlay);

function renderNodeList() {
  const important = [...graph.nodes].filter(node => node.degree !== 2).sort((a, b) => b.degree - a.degree).slice(0, 120);
  $('nodeList').innerHTML = important.map(node => `
    <div class="rowitem" data-node="${escapeHtml(node.id)}"><span class="id">${escapeHtml(node.id)}</span>
      <span class="meta">x ${node.x.toFixed(1)} · y ${node.y.toFixed(1)}</span><span class="mini">${node.degree} конц.</span></div>`).join('') || '<div class="helper">Нет узлов с необычной степенью.</div>';
  $('nodeList').querySelectorAll('[data-node]').forEach(row => row.addEventListener('click', () => selectNode(row.dataset.node)));
}
function nextEdgeId() {
  const nums = graph.edges.map(edge => Number(String(edge.id).replace(/^E/, '')) || 0);
  return `E${Math.max(0, ...nums) + 1}`;
}
function addManualConnection(from, to) {
  const a = graph.nodes.find(node => node.id === from);
  const b = graph.nodes.find(node => node.id === to);
  if (!a || !b || a.id === b.id) return false;
  const exists = graph.edges.some(edge => (edge.from === a.id && edge.to === b.id) || (edge.from === b.id && edge.to === a.id));
  if (exists) return false;
  graph.edges.push({ id: nextEdgeId(), from: a.id, to: b.id, source: 'manual', confidence: 1,
    geometry: [[a.x, a.y], [b.x, b.y]], visible: true, review: false, detector: 'MANUAL',
    component_role: 'line_structure', component_id: 'MANUAL' });
  a.degree = (a.degree || 0) + 1;
  b.degree = (b.degree || 0) + 1;
  $('edgeCount').textContent = graph.edges.length.toLocaleString('ru-RU');
  renderOverlay(); renderClean(); renderEdgeList(); renderNodeList(); renderJoinList();
  return true;
}
$('connectMode').addEventListener('click', () => {
  connectMode = !connectMode;
  firstNode = null;
  if (connectMode) $('showNodes').checked = true;
  $('connectHelp').hidden = !connectMode;
  $('connectHelp').textContent = 'Выбери первый узел, затем второй. Соединение будет добавлено вручную.';
  $('connectMode').textContent = connectMode ? 'Отмена соединения' : '＋ Соединить два узла';
  $('selectMode').textContent = connectMode ? 'Режим: выбери два узла' : 'Режим: просмотр';
  renderOverlay();
});
function chooseNode(id) {
  if (!firstNode) {
    firstNode = id;
    $('connectHelp').textContent = `Первый узел: ${id}. Теперь выбери второй узел.`;
    renderOverlay();
    return;
  }
  if (firstNode === id) return;
  const from = firstNode;
  if (addManualConnection(from, id)) $('selectMode').textContent = `Добавлено соединение ${from} ↔ ${id}`;
  connectMode = false;
  firstNode = null;
  $('connectHelp').hidden = true;
  $('connectMode').textContent = '＋ Соединить два узла';
  renderOverlay();
}
function renderJoinList() {
  const joins = graph.joinCandidates.slice(0, 80);
  $('joinList').innerHTML = joins.length ? joins.map(join => `
    <div class="rowitem"><span class="id">${escapeHtml(join.id)}</span><span class="meta">${escapeHtml(join.from)} ↔ ${escapeHtml(join.to)} · ${join.distance} px</span><button type="button" data-join="${escapeHtml(join.id)}">Соединить</button></div>`).join('') : '<div class="helper">Нет коротких соосных разрывов-кандидатов.</div>';
  $('joinList').querySelectorAll('[data-join]').forEach(button => button.addEventListener('click', () => {
    const candidate = graph.joinCandidates.find(item => item.id === button.dataset.join);
    if (candidate && addManualConnection(candidate.from, candidate.to)) {
      graph.joinCandidates = graph.joinCandidates.filter(item => item.id !== candidate.id);
      renderJoinList();
    }
  }));
}
function renderTextList() {
  const annotations = graph.annotations.filter(item => item.source === 'tesseract');
  $('textList').innerHTML = annotations.length ? annotations.map(annotation => `
    <div class="rowitem"><input type="checkbox" data-verified="${escapeHtml(annotation.id)}" ${annotation.verified ? 'checked' : ''} title="Проверено">
      <span class="id">${escapeHtml(annotation.id)}</span>
      <input type="text" data-text="${escapeHtml(annotation.id)}" value="${escapeHtml(annotation.text)}" aria-label="Текст ${escapeHtml(annotation.id)}">
      <span class="mini">${annotation.confidence}%</span></div>`).join('') : '<div class="helper">OCR не нашёл подписи с достаточной уверенностью. На геометрию это не влияет.</div>';
  $('textList').querySelectorAll('[data-text]').forEach(input => input.addEventListener('input', () => {
    const annotation = graph.annotations.find(item => item.id === input.dataset.text);
    if (annotation) annotation.text = input.value;
    renderClean();
  }));
  $('textList').querySelectorAll('[data-verified]').forEach(input => input.addEventListener('change', () => {
    const annotation = graph.annotations.find(item => item.id === input.dataset.verified);
    if (annotation) annotation.verified = input.checked;
    renderClean();
  }));
}

function buildChains(edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push(edge);
    adjacency.get(edge.to).push(edge);
  }
  const visited = new Set();
  const chains = [];
  function trace(startNode, firstEdge) {
    let node = startNode;
    let edge = firstEdge;
    const points = [];
    const edgeIds = [];
    while (edge && !visited.has(edge.id)) {
      visited.add(edge.id);
      edgeIds.push(edge.id);
      const oriented = edge.from === node ? edge.geometry : [...edge.geometry].reverse();
      if (!points.length) points.push(...oriented);
      else points.push(...oriented.slice(1));
      const next = edge.from === node ? edge.to : edge.from;
      const candidates = (adjacency.get(next) || []).filter(item => !visited.has(item.id));
      if ((adjacency.get(next) || []).length !== 2 || !candidates.length) break;
      node = next;
      edge = candidates[0];
    }
    if (points.length >= 2) chains.push({ points, edgeIds });
  }
  for (const [node, incident] of adjacency) {
    if (incident.length === 2) continue;
    for (const edge of incident) if (!visited.has(edge.id)) trace(node, edge);
  }
  for (const edge of edges) if (!visited.has(edge.id)) trace(edge.from, edge);
  return chains;
}
function svgEscape(value) {
  return escapeHtml(value);
}
function buildSheetSvg() {
  const width = graph.image.width;
  const height = graph.image.height;
  const edges = shownEdges();
  const pageWidth = 1200, pageHeight = 850, margin = 70, availableHeight = pageHeight - 190;
  const scale = Math.min((pageWidth - margin * 2) / width, availableHeight / height);
  const offsetX = (pageWidth - width * scale) / 2;
  const offsetY = 70 + (availableHeight - height * scale) / 2;
  const output = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 ${pageWidth} ${pageHeight}">`,
    `<rect width="${pageWidth}" height="${pageHeight}" fill="#fff"/>`,
    '<rect x="22" y="22" width="1156" height="806" fill="none" stroke="#111" stroke-width="1.2"/>',
    '<text x="40" y="49" font-family="Arial,sans-serif" font-size="15" font-weight="bold">СХЕМА ТРУБОПРОВОДА</text>',
    '<text x="40" y="65" font-family="Arial,sans-serif" font-size="8" fill="#555">Предварительная векторная реконструкция · соединения и размеры требуют проверки</text>',
    `<g transform="translate(${offsetX} ${offsetY}) scale(${scale})" fill="none" stroke="#111" stroke-width="${Math.max(.45, 1.6 / scale)}" stroke-linecap="round" stroke-linejoin="round">`
  ];
  const chains = buildChains(edges);
  for (const chain of chains) {
    const points = chain.points.map(point => `${point[0]},${point[1]}`).join(' ');
    output.push(`<polyline points="${points}"/>`);
  }
  output.push('</g>');
  for (const annotation of graph.annotations.filter(item => item.verified && item.text && item.bbox)) {
    const box = annotation.bbox;
    const x = offsetX + (box.x + box.w / 2) * scale;
    const y = offsetY + (box.y + box.h / 2) * scale;
    output.push(`<text x="${x}" y="${y}" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#111">${svgEscape(annotation.text)}</text>`);
  }
  output.push(
    '<path d="M22 760 H1178 M820 760 V828" fill="none" stroke="#111" stroke-width=".8"/>',
    '<text x="40" y="782" font-family="Arial,sans-serif" font-size="9">ПРОВЕРИТЬ УЗЛЫ, ПЕРЕСЕЧЕНИЯ И РАЗМЕРЫ ПО ОРИГИНАЛУ</text>',
    '<text x="838" y="782" font-family="Arial,sans-serif" font-size="9">CAD RECONSTRUCTION ENGINE 4.1.1</text>',
    '</svg>'
  );
  return output.join('\n');
}
function renderClean() {
  if (!graph) return;
  const visible = shownEdges();
  if (!visible.length) {
    $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><div class="empty-art blue"><span>CAD</span></div><b>Нет выбранных линий</b><span>Включи «Показать все» или отметь кандидаты в списке слева.</span></div>';
    return;
  }
  $('cleanStage').innerHTML = buildSheetSvg();
}
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function buildDxf() {
  const output = ['0','SECTION','2','HEADER','9','$ACADVER','1','AC1015','0','ENDSEC','0','SECTION','2','ENTITIES'];
  for (const chain of buildChains(shownEdges())) {
    if (chain.points.length < 2) continue;
    output.push('0','LWPOLYLINE','8','PIPE_CANDIDATES','90',String(chain.points.length),'70','0');
    for (const point of chain.points) output.push('10',String(point[0]),'20',String(graph.image.height - point[1]));
  }
  for (const annotation of graph.annotations.filter(item => item.verified && item.text && item.bbox)) {
    const box = annotation.bbox;
    output.push('0','TEXT','8','VERIFIED_TEXT','10',String(box.x),'20',String(graph.image.height - box.y - box.h),'40','8','1',annotation.text);
  }
  output.push('0','ENDSEC','0','EOF');
  return output.join('\n') + '\n';
}
$('exportSvg').addEventListener('click', () => downloadFile('reconstructed-scheme.svg', buildSheetSvg(), 'image/svg+xml'));
$('exportDxf').addEventListener('click', () => downloadFile('reconstructed-scheme.dxf', buildDxf(), 'application/dxf'));
$('exportJson').addEventListener('click', () => downloadFile('reconstruction-graph.json', JSON.stringify(graph, null, 2), 'application/json'));
$('exportPdf').addEventListener('click', () => {
  const popup = window.open('', '_blank');
  if (!popup) { setAlert('Разреши всплывающие окна, чтобы открыть печать в PDF.'); return; }
  popup.document.open();
  popup.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Трубопроводная схема</title><style>@page{size:A3 landscape;margin:0}html,body{margin:0;padding:0;width:420mm;height:297mm}svg{display:block;width:420mm;height:297mm}</style></head><body>${buildSheetSvg()}<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`);
  popup.document.close();
});

window.addEventListener('error', event => {
  console.error(event.error || event.message);
  setAlert(`Ошибка интерфейса: ${event.message || 'неизвестная ошибка JavaScript'}`);
});
window.addEventListener('unhandledrejection', event => {
  console.error(event.reason);
  setAlert(`Ошибка операции: ${event.reason?.message || event.reason || 'неизвестная ошибка'}`);
});
fetch('/api/health', { cache: 'no-store' }).then(response => response.json()).then(health => {
  $('serverState').textContent = health.ok ? 'Сервер готов' : 'Сервер недоступен';
}).catch(() => {
  $('serverState').textContent = 'Проверить сервер';
});
