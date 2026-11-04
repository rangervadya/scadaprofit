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
  $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><div class="empty-art blue"><span>CAD</span></div><b>Фото загружено — схема ещё не построена</b><span>Нажми «Распознать трубы и надписи».</span></div>';
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
  $('progressLabel').textContent = 'Qwen: распознавание подписей и осевых трасс труб…';
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
    if (!response.ok) {
      const error = new Error(data.details || data.error || `Ошибка сервера ${response.status}`);
      error.progressUrl = data.progressUrl || null;
      throw error;
    }
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
    if (typeof error.progressUrl === 'string' && error.progressUrl.startsWith('/jobs/')) {
      const link = document.createElement('a');
      link.href = error.progressUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'Открыть журнал этапов';
      $('inlineError').append(document.createTextNode(' '), link);
    }
    $('previewMeta').textContent = 'Обработка не завершилась';
    setState('ОШИБКА АНАЛИЗА', 'error');
  } finally {
    $('progressWrap').hidden = true;
    analyzeBtn.disabled = !selectedFile;
    analyzeBtn.querySelector('span:nth-child(2)').textContent = 'Распознать трубы и надписи';
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
  const diagnostics = $('diagnosticLinks');
  if (diagnostics) {
    const links = [
      graph.primaryOverlayUrl ? `<a href="${escapeHtml(graph.primaryOverlayUrl)}" target="_blank" rel="noreferrer">Отбор PIPE_MAIN</a>` : '',
      graph.textMaskUrl ? `<a href="${escapeHtml(graph.textMaskUrl)}" target="_blank" rel="noreferrer">Маска OCR-областей</a>` : '',
      graph.geometryInkUrl ? `<a href="${escapeHtml(graph.geometryInkUrl)}" target="_blank" rel="noreferrer">Чернила без текста</a>` : '',
      graph.handwrittenTextBlocksUrl ? `<a href="${escapeHtml(graph.handwrittenTextBlocksUrl)}" target="_blank" rel="noreferrer">Текстовые блоки OCR</a>` : '',
      graph.progressUrl ? `<a href="${escapeHtml(graph.progressUrl)}" target="_blank" rel="noreferrer">Журнал обработки</a>` : ''
    ].filter(Boolean);
    diagnostics.innerHTML = links.join('<span>·</span>');
    diagnostics.hidden = !links.length;
  }
  $('previewMeta').textContent = 'Анализ завершён · можно редактировать';
  const trace = graph.semanticTrace || {};
  const summary = graph.summary || {};
  const qwenRouteCount = Number(summary.semantic_routes ?? graph.semanticRoutes?.length ?? 0);
  const primaryPathCount = Number(summary.cad_primary_total_paths ?? summary.cad_primary_chains ?? summary.cad_primary_paths ?? 0);
  const qwenPrimaryCount = Number(summary.cad_primary_qwen_routes ?? 0);
  const isolatedReview = Number(summary.isolated_strokes_kept_for_review || 0);
  const textBlockCount = Number(summary.text_block_annotations || 0);
  const textReviewCount = Number(summary.text_review_annotations || 0);
  const traceState = `Основных CAD-путей: ${primaryPathCount} (Qwen, подтверждённых чернилами: ${qwenPrimaryCount}). Остальные маршруты Qwen: ${qwenRouteCount - qwenPrimaryCount}. Строк из рукописных блоков: ${textBlockCount}; текст на ручную проверку: ${textReviewCount}. Изолированных штрихов на проверке: ${isolatedReview}. `;
  $('statusline').textContent = traceState + graph.warnings.join(' ');
  const stats = [
    [summary.segment_candidates ?? graph.edges.length, 'отрезков-кандидатов'],
    [summary.nodes ?? graph.nodes.length, 'узлов графа'],
    [summary.edges ?? graph.edges.length, 'связей'],
    [summary.crossings_to_review ?? graph.crossings.length, 'пересечений на проверку'],
    [summary.ocr_annotations ?? graph.annotations.length, 'OCR-подписей'],
    [primaryPathCount, 'основных CAD-путей']
  ];
  $('stats').innerHTML = stats.map(([value, label]) => `<div class="stat"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`).join('');
  $('edgeCount').textContent = graph.edges.length.toLocaleString('ru-RU');
  $('nodeCount').textContent = graph.nodes.length.toLocaleString('ru-RU');
  $('textCount').textContent = graph.annotations.filter(a => ['qwen3-vl', 'qwen3-vl-block', 'tesseract'].includes(a.source)).length.toLocaleString('ru-RU');
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
function isPrimaryCadEdge(edge) {
  if (!edge || edge.visible === false) return false;
  if (edge.source === 'manual') return true;
  return edge.user_include === true || edge.cad_include === true ||
    (edge.cad_include === undefined && edge.component_role === 'line_structure');
}
function shownEdges() {
  return graph.edges.filter(edge => edge.visible !== false && (showAllSegments || isPrimaryCadEdge(edge)));
}
function lineColor(edge) {
  if (edge.source === 'manual') return '#ca5f54';
  return edge.detector === 'HOUGH' ? '#168e70' : '#e28a42';
}
function renderOverlay() {
  if (!graph) return;
  const visible = shownEdges();
  // Detector-selected CAD paths are the primary overlay. Qwen suggestions are
  // shown separately as dashed violet review traces; they never replace or
  // suppress the selected OpenCV geometry.
  const detectorLines = visible.map(edge => {
    const points = (edge.geometry || []).map(point => `${Number(point[0]).toFixed(2)},${Number(point[1]).toFixed(2)}`).join(' ');
    if (!points) return '';
    return `<polyline data-edge="${escapeHtml(edge.id)}" points="${points}" fill="none" stroke="${lineColor(edge)}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" opacity=".94"/>`;
  }).join('');
  const semanticRoutes = !showAllSegments && Array.isArray(graph.semanticRoutes)
    ? graph.semanticRoutes.filter(route => route.include !== false && Number(route.confidence ?? 60) >= 35) : [];
  const qwenPrimaryLines = semanticRoutes.filter(route => route.primary_validated).map(route => {
    const points = (route.points || []).map(point => `${Number(point[0]).toFixed(2)},${Number(point[1]).toFixed(2)}`).join(' ');
    return points ? `<polyline data-route="${escapeHtml(route.id)}" points="${points}" fill="none" stroke="#168e70" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity=".96"/>` : '';
  }).join('');
  const qwenReviewLines = semanticRoutes.filter(route => !route.primary_validated).map(route => {
    const points = (route.points || []).map(point => `${Number(point[0]).toFixed(2)},${Number(point[1]).toFixed(2)}`).join(' ');
    return points ? `<polyline data-route="${escapeHtml(route.id)}" points="${points}" fill="none" stroke="#8b62a3" stroke-width="2.2" stroke-dasharray="7 5" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/>` : '';
  }).join('');
  const lines = detectorLines + qwenPrimaryLines + qwenReviewLines;
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
  $('edgeList').innerHTML = visiblePage.map(edge => {
    const primary = edge.source === 'manual' || edge.user_include === true || edge.cad_include === true ||
      (edge.cad_include === undefined && edge.component_role === 'line_structure');
    const checked = edge.visible !== false && (showAllSegments || primary);
    const role = edge.source === 'manual' ? 'ручная' : (primary ? 'основная' : (edge.cad_reason || 'деталь'));
    return `
    <label class="rowitem"><input type="checkbox" data-toggle-edge="${escapeHtml(edge.id)}" ${checked ? 'checked' : ''}>
      <span class="id">${escapeHtml(edge.id)}</span>
      <span class="meta">${edgeLength(edge).toFixed(0)} px · ${escapeHtml(edge.detector || 'MANUAL')} · ${escapeHtml(role)}</span>
      <span class="mini">${Math.round((edge.confidence || 0) * 100)}%</span>
    </label>`;
  }).join('') || '<div class="helper">По этому запросу линий не найдено.</div>';
  $('edgeMore').hidden = visiblePage.length >= filtered.length;
  $('edgeMore').textContent = `Показать ещё (${Math.min(EDGE_PAGE_SIZE, filtered.length - visiblePage.length)})`;
  $('edgeList').querySelectorAll('[data-toggle-edge]').forEach(input => input.addEventListener('change', () => {
    const edge = graph.edges.find(item => item.id === input.dataset.toggleEdge);
    if (edge) {
      edge.visible = input.checked;
      if (input.checked && edge.cad_include === false) edge.user_include = true;
      if (!input.checked) edge.user_include = false;
    }
    renderOverlay();
    renderClean();
  }));
}
$('edgeSearch').addEventListener('input', () => { edgePage = 1; renderEdgeList(); });
$('edgeMore').addEventListener('click', () => { edgePage++; renderEdgeList(); });
$('allEdges').addEventListener('click', () => { showAllSegments = true; renderOverlay(); renderClean(); renderEdgeList(); });
$('longEdges').addEventListener('click', () => { showAllSegments = false; renderOverlay(); renderClean(); renderEdgeList(); });
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
  const joins = Array.isArray(graph.joinCandidates) ? graph.joinCandidates.slice(0, 80) : [];
  $('joinList').innerHTML = joins.length ? joins.map(join => {
    const high = join.priority === 'high' && !join.has_alternatives;
    const flags = Array.isArray(join.review_flags) ? join.review_flags : [];
    const details = [
      `${join.distance} px`,
      `соосность ${Math.round(Number(join.alignment || 0) * 100)}%`,
      `поперечное ${join.lateral_offset_px ?? '?'} px`
    ].join(' · ');
    const warning = join.has_alternatives ? 'Есть альтернативные пары' : (join.message || 'Требуется визуальная проверка');
    return `<div class="rowitem join-candidate ${high ? 'join-high' : 'join-review'}">
      <span class="id">${escapeHtml(join.id)}</span>
      <span class="meta" title="${escapeHtml(warning)}">${escapeHtml(join.from)} ↔ ${escapeHtml(join.to)} · ${escapeHtml(details)}<small>${escapeHtml(warning)}${flags.length ? ` · ${escapeHtml(flags.join(', '))}` : ''}</small></span>
      <button type="button" data-join="${escapeHtml(join.id)}" title="Добавить ручной соединительный отрезок">Добавить</button>
    </div>`;
  }).join('') : '<div class="helper">Подходящих пар открытых концов не найдено. Кандидаты не добавляются автоматически.</div>';
  $('joinList').querySelectorAll('[data-join]').forEach(button => button.addEventListener('click', () => {
    const candidate = graph.joinCandidates.find(item => item.id === button.dataset.join);
    if (!candidate) return;
    if (candidate.has_alternatives && !window.confirm(`У одного из концов есть альтернативные пары. Добавить только ${candidate.from} ↔ ${candidate.to}?`)) return;
    if (addManualConnection(candidate.from, candidate.to)) {
      const used = new Set([candidate.from, candidate.to]);
      // An open endpoint should not be consumed by two alternative continuations.
      graph.joinCandidates = graph.joinCandidates.filter(item =>
        item.id !== candidate.id && !used.has(item.from) && !used.has(item.to));
      renderJoinList();
    }
  }));
}
function renderTextList() {
  const annotations = graph.annotations.filter(item => ['qwen3-vl', 'qwen3-vl-block', 'tesseract'].includes(item.source) && item.text);
  $('textList').innerHTML = annotations.length ? annotations.map(annotation => `
    <div class="rowitem"><input type="checkbox" data-include-annotation="${escapeHtml(annotation.id)}" ${((annotation.include ?? annotation.verified) ? 'checked' : '')} title="Заменить рукописную надпись CAD-текстом" aria-label="Заменить рукописную надпись ${escapeHtml(annotation.id)} CAD-текстом">
      <span class="id">${escapeHtml(annotation.id)}</span>
      <input type="text" data-text="${escapeHtml(annotation.id)}" value="${escapeHtml(annotation.text)}" aria-label="Текст ${escapeHtml(annotation.id)}">
      <span class="mini">${escapeHtml(String(annotation.confidence ?? 0))}% · ${annotation.source === 'qwen3-vl-block' ? 'Qwen · строка' : annotation.source === 'qwen3-vl' ? 'Qwen' : 'Tesseract'}</span></div>`).join('') : '<div class="helper">Qwen3-VL и Tesseract не нашли читаемых подписей. Подтверждённый текст выводится как редактируемая CAD-надпись, а не как штрихи.</div>';
  $('textList').querySelectorAll('[data-text]').forEach(input => input.addEventListener('input', () => {
    const annotation = graph.annotations.find(item => item.id === input.dataset.text);
    if (annotation) annotation.text = input.value;
    renderClean();
  }));
  $('textList').querySelectorAll('[data-include-annotation]').forEach(input => input.addEventListener('change', () => {
    const annotation = graph.annotations.find(item => item.id === input.dataset.includeAnnotation);
    if (annotation) {
      annotation.include = input.checked;
      annotation.verified = input.checked;
    }
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
function nearAxis(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 8) return '';
  const tolerance = Math.max(1.0, length * 0.035);
  if (Math.abs(dy) <= tolerance) return 'H';
  if (Math.abs(dx) <= tolerance) return 'V';
  return '';
}
function cleanCadPoints(sourcePoints) {
  const points = sourcePoints.map(point => [Number(point[0]), Number(point[1])]);
  const unique = points.filter((point, index) => !index || Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) > 0.8);
  if (unique.length < 3) return unique.map(point => point.map(value => Number(value.toFixed(1))));

  // Regularize only corners that are already almost horizontal/vertical.
  // Deliberately leave genuinely diagonal branches untouched.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < unique.length - 1; i++) {
      const incoming = nearAxis(unique[i - 1], unique[i]);
      const outgoing = nearAxis(unique[i], unique[i + 1]);
      if (incoming === 'H' && outgoing === 'V') {
        unique[i][0] = unique[i + 1][0];
        unique[i][1] = unique[i - 1][1];
      } else if (incoming === 'V' && outgoing === 'H') {
        unique[i][0] = unique[i - 1][0];
        unique[i][1] = unique[i + 1][1];
      } else if (incoming === 'H' && outgoing === 'H') {
        unique[i][1] = (unique[i - 1][1] + unique[i + 1][1]) / 2;
      } else if (incoming === 'V' && outgoing === 'V') {
        unique[i][0] = (unique[i - 1][0] + unique[i + 1][0]) / 2;
      }
    }
  }

  // Remove detector vertices that merely split one straight stroke.
  const simplified = [unique[0]];
  for (let i = 1; i < unique.length - 1; i++) {
    const a = simplified[simplified.length - 1], b = unique[i], c = unique[i + 1];
    const ab = [b[0] - a[0], b[1] - a[1]], bc = [c[0] - b[0], c[1] - b[1]];
    const la = Math.hypot(...ab), lb = Math.hypot(...bc);
    const cross = Math.abs(ab[0] * bc[1] - ab[1] * bc[0]);
    const dot = ab[0] * bc[0] + ab[1] * bc[1];
    const sameStraightStroke = la > 1 && lb > 1 && dot > 0 && cross / (la * lb) < 0.035;
    if (!sameStraightStroke) simplified.push(b);
  }
  simplified.push(unique.at(-1));

  // Remove hand-drawn detector jitter while preserving real elbows and branches.
  const tolerance = Math.max(1.15, Math.min(graph?.image?.width || 1200, graph?.image?.height || 850) * 0.002);
  const distanceToSegment = (point, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    if (length2 < 1e-9) return Math.hypot(point[0] - a[0], point[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2));
    return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
  };
  const rdp = (list) => {
    if (list.length <= 2) return list;
    let maxDistance = 0, split = 0;
    for (let i = 1; i < list.length - 1; i++) {
      const distance = distanceToSegment(list[i], list[0], list.at(-1));
      if (distance > maxDistance) { maxDistance = distance; split = i; }
    }
    if (maxDistance <= tolerance) return [list[0], list.at(-1)];
    return [...rdp(list.slice(0, split + 1)).slice(0, -1), ...rdp(list.slice(split))];
  };
  return rdp(simplified).map(point => point.map(value => Number(value.toFixed(1))));
}
function cleanCadChains() {
  // OpenCV supplies the topology graph; Qwen paths are admitted only after
  // the server has validated their coordinates against source-image ink and
  // excluded text-only strokes. This combines recall with OCR-aware filtering.
  const primaryEdges = graph.edges.filter(isPrimaryCadEdge);
  const opencv = buildChains(primaryEdges).map(chain => ({
    ...chain, points: cleanCadPoints(chain.points), source: 'opencv'
  })).filter(chain => chain.points.length >= 2);
  const semantic = (graph.primarySemanticRoutes || []).map(route => ({
    edgeIds: [], points: cleanCadPoints(route.points || []), source: 'qwen-ink-validated', id: route.id
  })).filter(chain => chain.points.length >= 2);
  return [...opencv, ...semantic];
}
function annotationExportLayer(item) {
  if (!item || !item.text || !item.bbox) return null;
  if ((item.include ?? item.verified) && item.verified) return 'VERIFIED_TEXT';
  const confidence = Number(item.confidence ?? 0);
  if (item.source === 'qwen3-vl-block' || (confidence >= 38 && item.text !== '?')) return 'TEXT_REVIEW';
  return null;
}

function svgEscape(value) {
  return escapeHtml(value);
}
function buildSheetSvg() {
  const width = graph.image.width;
  const height = graph.image.height;
  const pageWidth = 1200, pageHeight = 850;
  const drawX = 36, drawY = 88, drawW = 1128, drawH = 652;
  const scale = Math.min(drawW / Math.max(1, width), drawH / Math.max(1, height));
  const offsetX = drawX + (drawW - width * scale) / 2;
  const offsetY = drawY + (drawH - height * scale) / 2;
  const chains = cleanCadChains();
  const output = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 ${pageWidth} ${pageHeight}">`,
    '<rect width="1200" height="850" fill="#fff"/>',
    '<g fill="none" stroke="#15191d" stroke-width="1">',
    '<rect x="24" y="24" width="1152" height="802"/>',
    '<path d="M36 78 H1164 M36 88 H1164 M36 740 H1164 M24 760 H1176 M830 760 V826"/>',
    '<rect x="36" y="88" width="1128" height="652" stroke="#aeb5bb" stroke-width=".55"/>',
    '<rect x="1010" y="32" width="154" height="34" stroke-width=".65"/>',
    '<path d="M1010 49 H1164" stroke-width=".55"/>',
    '</g>',
    '<text x="40" y="52" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#15191d">ТРУБОПРОВОДНАЯ СХЕМА</text>',
    '<text x="40" y="68" font-family="Arial,sans-serif" font-size="7.5" fill="#555e66">АВТОМАТИЧЕСКАЯ ВЕКТОРНАЯ РЕКОНСТРУКЦИЯ · ИСХОДНЫЙ МАСШТАБ НЕ КАЛИБРОВАН</text>',
    '<text x="1022" y="44" font-family="Arial,sans-serif" font-size="7" fill="#5b646b">ФОРМАТ</text>',
    '<text x="1022" y="61" font-family="Arial,sans-serif" font-size="10" font-weight="bold" fill="#15191d">A3 · ЛИСТ 1/1</text>',
    `<g transform="translate(${offsetX} ${offsetY}) scale(${scale})" fill="none" stroke="#15191d" stroke-width="${Math.max(.18, .62 / Math.max(scale, .001))}" stroke-linecap="round" stroke-linejoin="round">`
  ];
  for (const chain of chains) {
    const points = chain.points.map(point => `${point[0]},${point[1]}`).join(' ');
    output.push(`<polyline points="${points}"/>`);
  }
  output.push('</g>');
  if (!chains.length) {
    output.push('<text x="600" y="402" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="#a45f2a">ОСНОВНЫЕ ГЕОМЕТРИЧЕСКИЕ ЛИНИИ НЕ ВЫДЕЛЕНЫ</text>');
    output.push('<text x="600" y="426" text-anchor="middle" font-family="Arial,sans-serif" font-size="7.5" fill="#6b747a">Проверьте отбор OpenCV-кандидатов и слой DETAIL_REVIEW.</text>');
  }
  for (const annotation of graph.annotations.filter(item => annotationExportLayer(item))) {
    const layer = annotationExportLayer(annotation);
    const box = annotation.bbox;
    const x = offsetX + (box.x + box.w / 2) * scale;
    const y = offsetY + (box.y + box.h / 2) * scale;
    const labelWidth = Math.max(24, Math.min(220, String(annotation.text).length * 4.8 + 8));
    const fill = layer === 'VERIFIED_TEXT' ? '#fff' : '#fff7eb';
    const color = layer === 'VERIFIED_TEXT' ? '#15191d' : '#9b642d';
    const fontSize = layer === 'VERIFIED_TEXT' ? 8 : 7;
    output.push(`<rect x="${x - labelWidth / 2}" y="${y - 8.4}" width="${labelWidth}" height="13.2" fill="${fill}" stroke="none"/>`);
    output.push(`<text data-layer="${layer}" x="${x}" y="${y + 1}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" fill="${color}">${svgEscape(annotation.text)}</text>`);
  }
  output.push(
    '<text x="40" y="783" font-family="Arial,sans-serif" font-size="8" font-weight="bold" fill="#15191d">ОБОЗНАЧЕНИЯ И ПРИМЕЧАНИЯ</text>',
    '<text x="40" y="801" font-family="Arial,sans-serif" font-size="7" fill="#505960">Надписи OCR преобразованы в редактируемый текст. Геометрия показана отдельными CAD-полилиниями.</text>',
    '<text x="40" y="816" font-family="Arial,sans-serif" font-size="7" fill="#505960">Проверьте узлы, пересечения и размеры по оригиналу перед изготовлением или монтажом.</text>',
    '<text x="850" y="783" font-family="Arial,sans-serif" font-size="7" fill="#5b646b">ТИП ДОКУМЕНТА</text>',
    '<text x="850" y="801" font-family="Arial,sans-serif" font-size="9" font-weight="bold" fill="#15191d">СХЕМА ТРУБОПРОВОДА</text>',
    '<text x="850" y="816" font-family="Arial,sans-serif" font-size="7" fill="#505960">МАСШТАБ: НЕ ОПРЕДЕЛЁН · СТАТУС: ПРОВЕРИТЬ</text>',
    '</svg>'
  );
  return output.join('\n');
}

function renderClean() {
  if (!graph) return;
  const visible = shownEdges();
  const hasIncludedText = graph.annotations.some(item => annotationExportLayer(item));
  if (!visible.length && !(graph.semanticRoutes || []).length && !hasIncludedText) {
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
  const pageWidth = 1200, pageHeight = 850;
  const drawX = 36, drawY = 88, drawW = 1128, drawH = 652;
  const scale = Math.min(drawW / Math.max(1, graph.image.width), drawH / Math.max(1, graph.image.height));
  const offsetX = drawX + (drawW - graph.image.width * scale) / 2;
  const offsetY = drawY + (drawH - graph.image.height * scale) / 2;
  const output = ['0','SECTION','2','HEADER','9','$ACADVER','1','AC1021','9','$INSUNITS','70','4','0','ENDSEC',
    '0','SECTION','2','TABLES','0','TABLE','2','LTYPE','5','5','330','0','100','AcDbSymbolTable','70','1',
    '0','LTYPE','5','14','330','5','100','AcDbSymbolTableRecord','100','AcDbLinetypeTableRecord',
    '2','CONTINUOUS','70','0','3','Solid line','72','65','73','0','40','0.0','0','ENDTAB',
    '0','TABLE','2','LAYER','5','2','330','0','100','AcDbSymbolTable','70','7'];
  let layerHandle = 32;
  for (const [name, color, lineweight, flags] of [['SHEET',7,13,0],['PIPE_MAIN',7,13,0],['DETAIL_REVIEW',8,9,1],['QWEN_REVIEW',30,9,1],['VERIFIED_TEXT',7,13,0],['TEXT_REVIEW',30,9,1],['NOTES',8,9,0]]) {
    output.push('0','LAYER','5',layerHandle.toString(16).toUpperCase(),'330','2',
      '100','AcDbSymbolTableRecord','100','AcDbLayerTableRecord',
      '2',name,'70',String(flags),'62',String(color),'6','CONTINUOUS','370',String(lineweight));
    layerHandle++;
  }
  output.push('0','ENDTAB','0','ENDSEC','0','SECTION','2','ENTITIES');
  const pageToMm = (point) => [point[0] * 420 / pageWidth, (pageHeight - point[1]) * 297 / pageHeight];
  const addPolyline = (layer, points, closed = false, lineweight = 13) => {
    if (points.length < 2) return;
    output.push('0','LWPOLYLINE','100','AcDbEntity','8',layer,'100','AcDbPolyline',
      '370',String(lineweight),'90',String(points.length),'70',closed ? '1' : '0');
    for (const point of points) {
      const [x, y] = pageToMm(point);
      output.push('10',x.toFixed(3),'20',y.toFixed(3));
    }
  };
  const addText = (layer, value, pagePoint, textHeight) => {
    const text = String(value || '').replace(/[\r\n\0]+/g, ' ').slice(0, 240);
    if (!text) return;
    const [x, y] = pageToMm(pagePoint);
    output.push('0','TEXT','100','AcDbEntity','8',layer,'100','AcDbText',
      '10',x.toFixed(3),'20',y.toFixed(3),'30','0','40',String(textHeight),'1',text);
  };

  addPolyline('SHEET',[[24,24],[1176,24],[1176,826],[24,826]],true);
  addPolyline('SHEET',[[36,78],[1164,78]]);
  addPolyline('SHEET',[[36,88],[1164,88]]);
  addPolyline('SHEET',[[36,740],[1164,740]]);
  addPolyline('SHEET',[[24,760],[1176,760]]);
  addPolyline('SHEET',[[830,760],[830,826]]);
  addPolyline('SHEET',[[36,88],[1164,88],[1164,740],[36,740]],true,9);
  addPolyline('SHEET',[[1010,32],[1164,32],[1164,66],[1010,66]],true,9);
  addPolyline('SHEET',[[1010,49],[1164,49]],false,9);

  for (const chain of cleanCadChains()) {
    const points = chain.points.map(point => [offsetX + point[0] * scale, offsetY + point[1] * scale]);
    addPolyline('PIPE_MAIN',points,false,13);
  }
  // Unselected detector fragments stay available on a frozen review layer.
  // The main layer above uses cad_include/user_include regardless of whether
  // Qwen returned any suggestions.
  const reviewEdges = graph.edges.filter(item => item.source !== 'manual' && !isPrimaryCadEdge(item));
  for (const edge of reviewEdges) {
    const points = (edge.geometry || []).map(point => [offsetX + point[0] * scale, offsetY + point[1] * scale]);
    addPolyline('DETAIL_REVIEW',points,false,9);
  }
  // Semantic routes that failed ink/text validation remain review-only.
  for (const route of (graph.semanticRoutes || []).filter(item => item.include !== false && !item.primary_validated && Number(item.confidence ?? 60) >= 35)) {
    const points = (route.points || []).map(point => [offsetX + Number(point[0]) * scale, offsetY + Number(point[1]) * scale]);
    addPolyline('QWEN_REVIEW',points,false,9);
  }
  for (const annotation of graph.annotations.filter(item => annotationExportLayer(item))) {
    const layer = annotationExportLayer(annotation);
    const box = annotation.bbox;
    const x = offsetX + (box.x + box.w / 2) * scale;
    const y = offsetY + (box.y + box.h / 2) * scale;
    const widthMm = Math.min(70, String(annotation.text).length * 1.65);
    addText(layer,annotation.text,pageToPagePointCentered(x,y,widthMm,scale),layer === 'VERIFIED_TEXT' ? 3.0 : 2.7);
  }
  addText('NOTES','ТРУБОПРОВОДНАЯ СХЕМА',[40,52],5.6);
  addText('NOTES','АВТОМАТИЧЕСКАЯ ВЕКТОРНАЯ РЕКОНСТРУКЦИЯ - МАСШТАБ НЕ КАЛИБРОВАН',[40,68],2.6);
  addText('NOTES','ФОРМАТ',[1022,44],2.4);
  addText('NOTES','A3 - ЛИСТ 1/1',[1022,61],3.3);
  addText('NOTES','ОБОЗНАЧЕНИЯ И ПРИМЕЧАНИЯ',[40,783],2.8);
  addText('NOTES','OCR LABELS EXPORTED AS EDITABLE CAD TEXT; PIPE GEOMETRY IS ON A SEPARATE LAYER.',[40,801],2.2);
  addText('NOTES','VERIFY CONNECTIONS AND DIMENSIONS AGAINST THE ORIGINAL BEFORE CONSTRUCTION.',[40,816],2.2);
  addText('NOTES','ТИП ДОКУМЕНТА',[850,783],2.3);
  addText('NOTES','СХЕМА ТРУБОПРОВОДА',[850,801],3.0);
  addText('NOTES','МАСШТАБ: НЕ ОПРЕДЕЛЁН - СТАТУС: ПРОВЕРИТЬ',[850,816],2.1);
  output.push('0','ENDSEC','0','EOF');
  return output.join('\n') + '\n';
}
function pageToPagePointCentered(x, y, widthMm) {
  // Shift the left-aligned DXF TEXT insertion point so the label sits near its box centre.
  const pageWidthPerMm = 1200 / 420;
  return [x - (widthMm * pageWidthPerMm / 2), y];
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
  const ollama = health.ollama || {};
  if (!ollama.reachable) {
    $('serverState').textContent = 'Ollama недоступна';
    $('serverState').title = ollama.error || 'Проверьте контейнер Ollama';
  } else if (!ollama.modelInstalled) {
    $('serverState').textContent = `Не загружена ${health.qwenModel || 'Qwen'}`;
    $('serverState').title = ollama.hint || 'Выполните ollama pull для указанной модели';
  } else {
    $('serverState').textContent = 'Qwen готов';
    $('serverState').title = `Ollama доступна · ${health.qwenModel}`;
  }
}).catch(() => {
  $('serverState').textContent = 'Проверить сервер';
});
