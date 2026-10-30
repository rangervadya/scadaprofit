const fileInput = document.querySelector('#fileInput');
const dropzone = document.querySelector('#dropzone');
const uploadTitle = document.querySelector('#uploadTitle');
const uploadSubtitle = document.querySelector('#uploadSubtitle');
const sourcePreviewWrap = document.querySelector('#sourcePreviewWrap');
const sourcePreview = document.querySelector('#sourcePreview');
const qwenSourceMini = document.querySelector('#qwenSourceMini');
const qwenSourcePlaceholder = document.querySelector('#qwenSourcePlaceholder');
const sourceName = document.querySelector('#sourceName');
const removeFileButton = document.querySelector('#removeFile');
const convertButton = document.querySelector('#convertButton');
const convertButtonText = document.querySelector('#convertButtonText');
const downloadButton = document.querySelector('#downloadButton');
const downloadSvgButton = document.querySelector('#downloadSvgButton');
const downloadDxfButton = document.querySelector('#downloadDxfButton');
const resultImage = document.querySelector('#resultImage');
const resultImageWrap = document.querySelector('#resultImageWrap');
const emptyState = document.querySelector('#emptyState');
const loadingState = document.querySelector('#loadingState');
const resultTag = document.querySelector('#resultTag');
const resultMeta = document.querySelector('#resultMeta');
const apiDot = document.querySelector('#apiDot');
const apiStatus = document.querySelector('#apiStatus');
const toast = document.querySelector('#toast');
const notesInput = document.querySelector('#notes');
const preserveDetailsInput = document.querySelector('#strictMode');
const modeInput = document.querySelector('#mode');
const loadingHint = document.querySelector('#loadingHint');
const analysisText = document.querySelector('#analysisText');
const ocrText = document.querySelector('#ocrText');
const analysisNote = document.querySelector('#analysisNote');
const qwenExtractButton = document.querySelector('#qwenExtractButton');
const qwenRouteButton = document.querySelector('#qwenRouteButton');
const graphInput = document.querySelector('#graphInput');
const startPointId = document.querySelector('#startPointId');
const endPointId = document.querySelector('#endPointId');
const routePrompt = document.querySelector('#routePrompt');
const qwenModelChip = document.querySelector('#qwenModelChip');
const graphSvg = document.querySelector('#graphSvg');
const graphEdges = document.querySelector('#graphEdges');
const graphNodes = document.querySelector('#graphNodes');
const graphEmpty = document.querySelector('#graphEmpty');
const graphStatus = document.querySelector('#jsonStatus');
const stepPrev = document.querySelector('#stepPrev');
const stepNext = document.querySelector('#stepNext');
const stepLabel = document.querySelector('#stepLabel');
const rawExtractOutput = document.querySelector('#rawExtractOutput');
const rawRouteOutput = document.querySelector('#rawRouteOutput');
const routeCheckOutput = document.querySelector('#routeCheckOutput');
const qwenTiming = document.querySelector('#qwenTiming');

let selectedFile = null;
let sourceObjectUrl = null;
let resultDataUrl = null;
let resultSvgUrl = null;
let resultDxfUrl = null;
let filenames = { png: 'cad-vector-preview.png', svg: 'cad-centerline-trace.svg', dxf: 'cad-centerline-trace.dxf' };
let toastTimer = null;
let loadingTimer = null;
let qwenPrompts = { visionPrompt: '', routePrompt: '' };
let extractResponse = null;
let routeResponse = null;
let activeJsonTab = 'extract';
let displayedGraph = null;
let graphSegments = [];
let activeSegmentIndex = 0;

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.remove('hidden');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add('hidden'), 7000);
}

function setServiceStatus({ processorReady = false } = {}) {
  apiDot.classList.toggle('ok', Boolean(processorReady));
  apiDot.classList.toggle('bad', !processorReady);
  apiStatus.textContent = processorReady ? 'Офлайн · OpenCV готов' : 'Локальный процессор недоступен';
}

async function checkServices() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (!response.ok) throw new Error('Health-check failed');
    setServiceStatus(data);
    analysisNote.textContent = data.processorReady
      ? 'Геометрия трассируется локально из пикселей: Ollama не рисует и не придумывает трубопровод. Масштаб и соединения нужно сверить с оригиналом.'
      : 'Локальный процессор не готов. Проверьте журнал Docker.';
  } catch {
    apiStatus.textContent = 'Локальный сервер недоступен';
    apiDot.classList.add('bad');
  }
}

function setSelectedFile(file) {
  if (!file) return;
  const acceptedTypes = ['image/png', 'image/jpeg', 'image/webp'];
  if (!acceptedTypes.includes(file.type)) {
    showToast('Выберите изображение в формате PNG, JPG/JPEG или WEBP.', true);
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showToast('Файл слишком большой. Максимальный размер — 15 МБ.', true);
    return;
  }
  selectedFile = file;
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = URL.createObjectURL(file);
  sourcePreview.src = sourceObjectUrl;
  qwenSourceMini.src = sourceObjectUrl;
  qwenSourcePlaceholder.classList.add('hidden');
  sourceName.textContent = file.name;
  uploadTitle.textContent = file.name;
  uploadSubtitle.textContent = 'Файл готов к локальной обработке';
  document.querySelector('.file-limit').textContent = `${(file.size / (1024 * 1024)).toFixed(2)} МБ · можно заменить другим файлом`;
  dropzone.classList.add('hidden');
  sourcePreviewWrap.classList.remove('hidden');
  convertButton.disabled = false;
  if (qwenExtractButton) qwenExtractButton.disabled = false;
  clearResult();
}

function resetSource() {
  selectedFile = null;
  fileInput.value = '';
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = null;
  sourcePreview.removeAttribute('src');
  qwenSourceMini.removeAttribute('src');
  qwenSourcePlaceholder.classList.remove('hidden');
  sourcePreviewWrap.classList.add('hidden');
  dropzone.classList.remove('hidden');
  uploadTitle.textContent = 'Перетащите фото сюда';
  uploadSubtitle.innerHTML = 'или <span class="text-link">выберите файл</span> на устройстве';
  document.querySelector('.file-limit').textContent = 'Максимальный размер файла — 15 МБ';
  convertButton.disabled = true;
  if (qwenExtractButton) qwenExtractButton.disabled = true;
  clearResult();
}

function clearResult() {
  resultDataUrl = null;
  resultSvgUrl = null;
  resultDxfUrl = null;
  resultImage.removeAttribute('src');
  resultImageWrap.classList.add('hidden');
  emptyState.classList.remove('hidden');
  loadingState.classList.add('hidden');
  downloadButton.disabled = true;
  downloadSvgButton.disabled = true;
  downloadDxfButton.disabled = true;
  resultTag.textContent = 'ОЖИДАНИЕ';
  resultTag.classList.remove('ready', 'review');
  resultMeta.textContent = 'PNG · SVG · DXF';
  analysisText.textContent = 'После обработки здесь появится статистика трассировки OpenCV.';
  ocrText.textContent = 'После обработки появятся кандидаты OCR. Текст нужно сверить вручную.';
  clearQwenLab();
}

function startLoading() {
  emptyState.classList.add('hidden');
  resultImageWrap.classList.add('hidden');
  loadingState.classList.remove('hidden');
  resultTag.textContent = 'ОБРАБОТКА';
  resultTag.classList.remove('ready', 'review');
  convertButton.disabled = true;
  convertButtonText.textContent = 'Идёт локальная обработка…';
  downloadButton.disabled = true;
  downloadSvgButton.disabled = true;
  downloadDxfButton.disabled = true;
  const hints = [
    'OpenCV выделяет цветные штрихи ручки или контрастные линии на бумаге.',
    'Утолщённые штрихи сжимаются до центральных линий (skeleton).',
    'Строим граф пикселей и сохраняем ветвления; ничего не дорисовываем по догадке.',
    'Tesseract ищет текстовые кандидаты отдельно от геометрии.',
    'Формируем PNG, SVG и DXF. Масштаб и соединения потребуют проверки.',
  ];
  let index = 0;
  loadingHint.textContent = hints[index];
  loadingTimer = window.setInterval(() => {
    index = (index + 1) % hints.length;
    loadingHint.textContent = hints[index];
  }, 3300);
}

function stopLoading() {
  window.clearInterval(loadingTimer);
  loadingTimer = null;
  loadingState.classList.add('hidden');
  convertButton.disabled = !selectedFile;
  convertButtonText.textContent = 'Обработать локально';
}

function downloadUrl(url, filename) {
  if (!url) return;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

fileInput.addEventListener('change', (event) => setSelectedFile(event.target.files?.[0]));
removeFileButton.addEventListener('click', resetSource);
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
  });
}
dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) setSelectedFile(file);
});

convertButton.addEventListener('click', async () => {
  if (!selectedFile) {
    showToast('Сначала выберите исходную схему.', true);
    return;
  }
  startLoading();
  try {
    const formData = new FormData();
    formData.append('image', selectedFile, selectedFile.name);
    formData.append('notes', notesInput.value.trim());
    formData.append('preserveDetails', String(Boolean(preserveDetailsInput?.checked)));
    formData.append('mode', modeInput?.value || 'cad');

    const response = await fetch('/api/convert', { method: 'POST', body: formData });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось обработать изображение.');
    if (!data.image?.startsWith('data:image/png;base64,') || !data.svg || !data.dxf) {
      throw new Error('Сервер вернул неполный комплект результатов.');
    }

    resultDataUrl = data.image;
    resultSvgUrl = data.svg;
    resultDxfUrl = data.dxf;
    filenames = data.filenames || filenames;
    resultImage.src = resultDataUrl;
    resultImageWrap.classList.remove('hidden');
    emptyState.classList.add('hidden');
    resultTag.textContent = 'НУЖНА ПРОВЕРКА';
    resultTag.classList.remove('ready');
    resultTag.classList.add('review');

    const stats = data.stats || {};
    resultMeta.textContent = `${stats.primaryPaths ?? 0} основных штрихов · ${stats.detailPaths ?? 0} дополнительных · ${stats.ocrCount ?? 0} OCR-кандидатов · ${stats.sheet || 'A3'}`;
    downloadButton.disabled = false;
    downloadSvgButton.disabled = false;
    downloadDxfButton.disabled = false;
    analysisText.textContent = data.analysis || 'Векторная трассировка выполнена локально.';
    ocrText.textContent = data.ocrText || 'Надписи не найдены.';
    analysisNote.textContent = [data.note, ...(data.warnings || [])].filter(Boolean).join(' ');
    setServiceStatus({ processorReady: true });
    showToast('Векторная трассировка построена. Сверьте каждый участок, поворот и узел с исходным эскизом.');
  } catch (error) {
    emptyState.classList.remove('hidden');
    resultTag.textContent = 'ОШИБКА';
    resultTag.classList.remove('ready', 'review');
    showToast(error.message || 'Не удалось выполнить локальную обработку.', true);
  } finally {
    stopLoading();
  }
});

downloadButton.addEventListener('click', () => downloadUrl(resultDataUrl, filenames.png));
downloadSvgButton.addEventListener('click', () => downloadUrl(resultSvgUrl, filenames.svg));
downloadDxfButton.addEventListener('click', () => downloadUrl(resultDxfUrl, filenames.dxf));

const SVG_NS = 'http://www.w3.org/2000/svg';

function setJsonStatus(label, tone = 'review') {
  graphStatus.textContent = label;
  graphStatus.classList.remove('ready', 'review');
  graphStatus.classList.add(tone);
}

function makeSvg(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function graphDataForPreview(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const points = Array.isArray(payload.points) ? payload.points : [];
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  return { points, lines, path: Array.isArray(payload.path) ? payload.path : [] };
}

function renderGraph(payload) {
  const graph = graphDataForPreview(payload);
  displayedGraph = graph;
  graphEdges.replaceChildren();
  graphNodes.replaceChildren();
  graphSegments = [];
  activeSegmentIndex = 0;
  if (!graph || graph.points.length === 0 || graph.lines.length === 0) {
    graphEmpty.classList.remove('hidden');
    stepLabel.textContent = 'Нет сегментов';
    stepPrev.disabled = true;
    stepNext.disabled = true;
    return;
  }
  const byId = new Map(graph.points.map(point => [point.id, point]));
  const segments = [];
  if (graph.path.length > 1) {
    const edgeLookup = new Map(graph.lines.map(line => [`${line.from}\u0000${line.to}`, line]));
    for (let i = 0; i < graph.path.length - 1; i++) {
      const from = graph.path[i];
      const to = graph.path[i + 1];
      if (edgeLookup.has(`${from}\u0000${to}`)) segments.push({ from, to, line: edgeLookup.get(`${from}\u0000${to}`) });
    }
  }
  if (segments.length === 0) {
    for (const line of graph.lines) segments.push({ from: line.from, to: line.to, line });
  }
  graphSegments = segments.filter((segment) => {
    const a = byId.get(segment.from);
    const b = byId.get(segment.to);
    return a && b && Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y)) && Number.isFinite(Number(b.x)) && Number.isFinite(Number(b.y));
  });
  const nodesInSegments = new Set();
  graphSegments.forEach((segment, index) => {
    const a = byId.get(segment.from);
    const b = byId.get(segment.to);
    nodesInSegments.add(segment.from);
    nodesInSegments.add(segment.to);
    const edge = makeSvg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'graph-edge', 'data-segment': index });
    const title = makeSvg('title');
    title.textContent = `${index + 1}. ${segment.from} → ${segment.to}`;
    edge.append(title);
    graphEdges.append(edge);
    const midpointX = (Number(a.x) + Number(b.x)) / 2;
    const midpointY = (Number(a.y) + Number(b.y)) / 2;
    const edgeLabel = makeSvg('text', { x: midpointX + 8, y: midpointY - 8, class: 'graph-edge-label' });
    edgeLabel.textContent = String(index + 1);
    graphEdges.append(edgeLabel);
  });
  for (const point of graph.points) {
    if (!nodesInSegments.has(point.id)) continue;
    const g = makeSvg('g', { 'data-point': point.id });
    const circle = makeSvg('circle', { cx: point.x, cy: point.y, r: 7, class: 'graph-node' });
    const label = makeSvg('text', { x: Number(point.x) + 12, y: Number(point.y) - 11, class: 'graph-node-label' });
    label.textContent = String(point.id);
    const title = makeSvg('title');
    title.textContent = `${point.id}: (${point.x}, ${point.y})`;
    g.append(circle, label, title);
    graphNodes.append(g);
  }
  graphEmpty.classList.add('hidden');
  stepPrev.disabled = graphSegments.length <= 1;
  stepNext.disabled = graphSegments.length <= 1;
  updateGraphStep();
}

function updateGraphStep() {
  const edges = [...graphEdges.querySelectorAll('.graph-edge')];
  const nodes = [...graphNodes.querySelectorAll('g[data-point]')];
  edges.forEach((edge, index) => edge.classList.toggle('active', index === activeSegmentIndex));
  const active = graphSegments[activeSegmentIndex];
  nodes.forEach((g) => {
    const circle = g.querySelector('circle');
    circle.classList.toggle('active', Boolean(active && (g.dataset.point === active.from || g.dataset.point === active.to)));
  });
  if (!graphSegments.length) {
    stepLabel.textContent = 'Нет сегментов';
    stepPrev.disabled = true;
    stepNext.disabled = true;
    return;
  }
  const count = graphSegments.length;
  const segment = graphSegments[activeSegmentIndex];
  stepLabel.textContent = `Шаг ${activeSegmentIndex + 1} из ${count}: ${segment.from} → ${segment.to}`;
  stepPrev.disabled = activeSegmentIndex <= 0;
  stepNext.disabled = activeSegmentIndex >= count - 1;
}

function showJsonTab(tab) {
  activeJsonTab = tab;
  document.querySelectorAll('.json-tab').forEach(button => {
    const active = button.dataset.jsonTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  rawExtractOutput.classList.toggle('hidden', tab !== 'extract');
  rawRouteOutput.classList.toggle('hidden', tab !== 'route');
  routeCheckOutput.classList.toggle('hidden', tab !== 'check');
}

function currentJsonOutput() {
  if (activeJsonTab === 'extract') return rawExtractOutput.textContent;
  if (activeJsonTab === 'route') return rawRouteOutput.textContent;
  return routeCheckOutput.textContent;
}

function clearQwenLab() {
  extractResponse = null;
  routeResponse = null;
  graphInput.value = JSON.stringify({ points: [{ id: 'P1', x: 199, y: 415 }, { id: 'P2', x: 854, y: 217 }], lines: [{ from: 'P1', to: 'P2' }] }, null, 2);
  startPointId.value = 'P1';
  endPointId.value = 'P2';
  rawExtractOutput.textContent = 'Готово. Нажми «Извлечь точки и линии с фото», чтобы увидеть raw JSON Qwen.';
  rawRouteOutput.textContent = 'Пока нет ответа Qwen для построения пути.';
  routeCheckOutput.textContent = 'Проверка появится после первого запроса.';
  qwenTiming.textContent = 'Визуализация строится непосредственно из координат JSON. Если JSON верный, а здесь линия неправильная — это ошибка визуализатора; если точки/связи ошибочны уже в JSON — проблема на этапе Qwen.';
  setJsonStatus('ОЖИДАНИЕ', 'review');
  renderGraph(JSON.parse(graphInput.value));
  showJsonTab('extract');
}

function safePretty(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

async function loadQwenPrompts() {
  try {
    const response = await fetch('/api/prompts');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось загрузить промпты.');
    qwenPrompts = data;
    routePrompt.value = data.routePrompt || '';
    qwenModelChip.textContent = `QWEN: ${data.model || 'НЕИЗВЕСТНАЯ МОДЕЛЬ'}`;
    rawExtractOutput.textContent = 'Готово. Выбери фото и нажми «Извлечь точки и линии с фото».\n\nПромпт извлечения сохранён на сервере и отправляется вместе с изображением.';
  } catch (error) {
    qwenModelChip.textContent = 'ПРОМПТ НЕДОСТУПЕН';
    showToast(error.message, true);
  }
}

qwenExtractButton.addEventListener('click', async () => {
  if (!selectedFile) return showToast('Сначала загрузи фотографию схемы в верхней части страницы.', true);
  const extractionFile = selectedFile;
  qwenExtractButton.disabled = true;
  qwenExtractButton.querySelector('span:nth-child(2)').textContent = 'Qwen извлекает JSON…';
  setJsonStatus('QWEN ОБРАБАТЫВАЕТ', 'review');
  rawExtractOutput.textContent = 'Отправляем фотографию и промпт в Ollama. Это может занять несколько минут…';
  showJsonTab('extract');
  const start = performance.now();
  try {
    const form = new FormData();
    form.append('image', extractionFile, extractionFile.name);
    if (qwenPrompts.visionPrompt) form.append('prompt', qwenPrompts.visionPrompt);
    const response = await fetch('/api/qwen-extract', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Ошибка извлечения JSON из изображения.');
    if (selectedFile !== extractionFile) { showToast('Файл изменился во время запроса. Старый ответ Qwen проигнорирован.'); return; }
    extractResponse = data;
    rawExtractOutput.textContent = data.rawContent || '(Qwen вернул пустой content)';
    if (data.parsed && Array.isArray(data.parsed.points) && Array.isArray(data.parsed.lines)) {
      graphInput.value = safePretty(data.parsed);
      const ids = data.parsed.points.map(p => p?.id).filter(id => typeof id === 'string');
      if (ids.length) {
        startPointId.value = ids[0];
        endPointId.value = ids[ids.length - 1];
      }
      renderGraph(data.parsed);
      setJsonStatus(`JSON ПОЛУЧЕН · ${data.parsed.points.length} ТОЧЕК · ${data.parsed.lines.length} ЛИНИЙ`, 'review');
      routeCheckOutput.textContent = safePretty({
        parseError: data.parseError,
        doneReason: data.doneReason,
        evalCount: data.evalCount,
        thinkingChars: (data.thinking || '').length,
        points: data.parsed.points.length,
        lines: data.parsed.lines.length,
        warnings: data.parsed.warnings || []
      });
    } else {
      setJsonStatus('JSON НЕ РАЗОБРАН', 'review');
      routeCheckOutput.textContent = safePretty({ parseError: data.parseError, doneReason: data.doneReason, evalCount: data.evalCount, thinkingChars: (data.thinking || '').length });
      renderGraph(null);
    }
    qwenTiming.textContent = `Модель: ${data.model}; время: ${((performance.now() - start) / 1000).toFixed(1)} с; done_reason: ${data.doneReason}; eval_count: ${data.evalCount ?? '—'}. Смотри raw content выше: это дословный JSON-ответ Qwen.`;
    showToast('Ответ Qwen получен. Сравни исходный JSON и граф справа.');
  } catch (error) {
    rawExtractOutput.textContent = error.message || String(error);
    setJsonStatus('ОШИБКА QWEN', 'review');
    showToast(error.message || 'Не удалось вызвать Qwen.', true);
  } finally {
    qwenExtractButton.disabled = !selectedFile;
    qwenExtractButton.querySelector('span:nth-child(2)').textContent = '1. Извлечь точки и линии с фото';
  }
});

qwenRouteButton.addEventListener('click', async () => {
  let graph;
  try { graph = JSON.parse(graphInput.value); }
  catch (error) { return showToast(`Входной JSON не разбирается: ${error.message}`, true); }
  qwenRouteButton.disabled = true;
  qwenRouteButton.querySelector('span:nth-child(2)').textContent = 'Qwen строит путь…';
  setJsonStatus('ПОСТРОЕНИЕ ПУТИ', 'review');
  rawRouteOutput.textContent = 'Отправляем JSON и большой промпт в Qwen…';
  showJsonTab('route');
  const start = performance.now();
  try {
    const response = await fetch('/api/qwen-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputJson: graphInput.value,
        startId: startPointId.value.trim(),
        endId: endPointId.value.trim(),
        prompt: routePrompt.value
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Ошибка построения пути.');
    routeResponse = data;
    rawRouteOutput.textContent = data.rawContent || '(Qwen вернул пустой content)';
    if (data.parsed) {
      const chosen = data.parsed.status === 'ok' ? data.parsed : graph;
      renderGraph(chosen);
      setJsonStatus(`QWEN: ${String(data.parsed.status || 'UNKNOWN').toUpperCase()}`, data.parsed.status === 'ok' && data.localValidation?.valid && data.inputValidation?.valid ? 'ready' : 'review');
    } else {
      renderGraph(graph);
      setJsonStatus('ОТВЕТ НЕ JSON', 'review');
    }
    routeCheckOutput.textContent = safePretty({
      parsed: data.parsed,
      parseError: data.parseError,
      inputValidation: data.inputValidation,
      localValidation: data.localValidation,
      doneReason: data.doneReason,
      evalCount: data.evalCount,
      thinkingChars: (data.thinking || '').length,
      model: data.model
    });
    qwenTiming.textContent = `Модель: ${data.model}; время: ${((performance.now() - start) / 1000).toFixed(1)} с; done_reason: ${data.doneReason}; eval_count: ${data.evalCount ?? '—'}. Если статус needs_review, граф исходных связей оставлен на экране, чтобы не скрывать входные данные.`;
    showToast(data.parsed?.status === 'ok' ? 'Путь получен. Проверь независимую проверку длины и непрерывности.' : 'Qwen не подтвердил однозначный путь. Показан входной граф.');
  } catch (error) {
    rawRouteOutput.textContent = error.message || String(error);
    setJsonStatus('ОШИБКА ПОСТРОЕНИЯ', 'review');
    showToast(error.message || 'Не удалось построить путь.', true);
  } finally {
    qwenRouteButton.disabled = false;
    qwenRouteButton.querySelector('span:nth-child(2)').textContent = '2. Построить путь по этому JSON';
  }
});

stepPrev.addEventListener('click', () => { activeSegmentIndex = Math.max(0, activeSegmentIndex - 1); updateGraphStep(); });
stepNext.addEventListener('click', () => { activeSegmentIndex = Math.min(graphSegments.length - 1, activeSegmentIndex + 1); updateGraphStep(); });
document.querySelectorAll('.json-tab').forEach(button => button.addEventListener('click', () => showJsonTab(button.dataset.jsonTab)));
document.querySelector('#previewInputJson').addEventListener('click', () => {
  try {
    const graph = JSON.parse(graphInput.value);
    renderGraph(graph);
    setJsonStatus('ПОКАЗАН ВХОДНОЙ JSON', 'review');
    showToast('Граф нарисован напрямую из текущего JSON — без запроса к Qwen и без CAD-рендерера.');
  } catch (error) {
    setJsonStatus('JSON ОШИБОЧЕН', 'review');
    showToast(`Входной JSON не разбирается: ${error.message}`, true);
  }
});

document.querySelector('#resetGraphJson').addEventListener('click', () => {
  graphInput.value = JSON.stringify({ points: [{ id: 'P1', x: 199, y: 415 }, { id: 'P2', x: 854, y: 217 }], lines: [{ from: 'P1', to: 'P2' }] }, null, 2);
  startPointId.value = 'P1'; endPointId.value = 'P2'; renderGraph(JSON.parse(graphInput.value));
});
document.querySelector('#restorePrompt').addEventListener('click', () => { routePrompt.value = qwenPrompts.routePrompt || ''; showToast('Стандартный промпт восстановлен.'); });
document.querySelector('#copyCurrentJson').addEventListener('click', async () => {
  const text = currentJsonOutput();
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('Clipboard API unavailable');
    showToast('JSON скопирован.');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();
    showToast(copied ? 'JSON скопирован.' : 'Не удалось скопировать JSON в этом браузере.', !copied);
  }
});
document.querySelector('#downloadCurrentJson').addEventListener('click', () => {
  const blob = new Blob([currentJsonOutput()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  downloadUrl(url, `qwen-${activeJsonTab}-response.json`);
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
});

loadQwenPrompts();
showJsonTab('extract');
renderGraph({ points: [{ id: 'P1', x: 199, y: 415 }, { id: 'P2', x: 854, y: 217 }], lines: [{ from: 'P1', to: 'P2' }] });

checkServices();
