const $ = (selector) => document.querySelector(selector);
const imageInput = $('#imageInput');
const dropzone = $('#dropzone');
const uploadTitle = $('#uploadTitle');
const uploadHint = $('#uploadHint');
const extractButton = $('#extractButton');
const removeImageButton = $('#removeImage');
const sourceImage = $('#sourceImage');
const imagePlaceholder = $('#imagePlaceholder');
const graphInput = $('#graphInput');
const startIdInput = $('#startId');
const endIdInput = $('#endId');
const routeButton = $('#routeButton');
const inputEdges = $('#inputEdges');
const modelEdges = $('#modelEdges');
const graphNodes = $('#graphNodes');
const graphEmpty = $('#graphEmpty');
const stepLabel = $('#stepLabel');
const prevStep = $('#prevStep');
const nextStep = $('#nextStep');
const routeState = $('#routeState');
const extractRaw = $('#extractRaw');
const routeRaw = $('#routeRaw');
const checkRaw = $('#checkRaw');
const timing = $('#timing');
const modelChip = $('#modelChip');
const visionPrompt = $('#visionPrompt');
const routePrompt = $('#routePrompt');
const toast = $('#toast');

let selectedFile = null;
let objectUrl = null;
let promptDefaults = { visionPrompt: '', routePrompt: '', model: '' };
let extractResponse = null;
let routeResponse = null;
let activeTab = 'extract';
let activeSegment = 0;
let stepSegments = [];
let toastTimer = null;

const sampleGraph = {
  points: [{ id: 'P1', x: 199, y: 415 }, { id: 'P2', x: 854, y: 217 }],
  lines: [{ from: 'P1', to: 'P2' }],
  warnings: [],
};

function notify(message, isError = false) {
  toast.textContent = message;
  toast.classList.remove('hidden', 'error');
  if (isError) toast.classList.add('error');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 5200);
}

function pretty(value) {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function setRawTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(button => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  extractRaw.classList.toggle('hidden', tab !== 'extract');
  routeRaw.classList.toggle('hidden', tab !== 'route');
  checkRaw.classList.toggle('hidden', tab !== 'check');
}

function currentOutput() {
  return activeTab === 'extract' ? extractRaw.textContent
    : activeTab === 'route' ? routeRaw.textContent : checkRaw.textContent;
}

function makeSvg(name, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function validGraphShape(graph) {
  if (!graph || typeof graph !== 'object') return { points: [], lines: [] };
  return {
    points: Array.isArray(graph.points) ? graph.points : [],
    lines: Array.isArray(graph.lines) ? graph.lines : [],
    path: Array.isArray(graph.path) ? graph.path : [],
  };
}

function linePoints(graph) {
  const byId = new Map(graph.points.map(point => [point?.id, point]));
  return graph.lines.map(line => ({ line, a: byId.get(line?.from), b: byId.get(line?.to) }))
    .filter(item => item.a && item.b && Number.isFinite(item.a.x) && Number.isFinite(item.a.y)
      && Number.isFinite(item.b.x) && Number.isFinite(item.b.y));
}

function renderGraph(inputGraph, candidateGraph = null) {
  const input = validGraphShape(inputGraph);
  const candidate = candidateGraph ? validGraphShape(candidateGraph) : { points: [], lines: [], path: [] };
  inputEdges.replaceChildren();
  modelEdges.replaceChildren();
  graphNodes.replaceChildren();
  stepSegments = [];
  activeSegment = 0;

  const inputSegments = linePoints(input);
  const modelSegments = linePoints(candidate);
  const allPoints = new Map();
  for (const point of [...input.points, ...candidate.points]) {
    if (point && typeof point.id === 'string' && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      allPoints.set(point.id, point);
    }
  }

  inputSegments.forEach(({ line, a, b }, index) => {
    const element = makeSvg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'input-edge' });
    const title = makeSvg('title');
    title.textContent = `Вход ${index + 1}: ${line.from} → ${line.to}`;
    element.append(title);
    inputEdges.append(element);
  });

  let ordered = [];
  if (candidate.path.length > 1) {
    const edgeMap = new Map(modelSegments.map(segment => [`${segment.line.from}\u0000${segment.line.to}`, segment]));
    for (let index = 0; index < candidate.path.length - 1; index += 1) {
      const from = candidate.path[index];
      const to = candidate.path[index + 1];
      const found = edgeMap.get(`${from}\u0000${to}`);
      if (found) ordered.push(found);
    }
  }
  if (!ordered.length) ordered = modelSegments;

  ordered.forEach(({ line, a, b }, index) => {
    const element = makeSvg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'model-edge', 'data-index': index });
    const title = makeSvg('title');
    title.textContent = `Qwen ${index + 1}: ${line.from} → ${line.to}`;
    element.append(title);
    modelEdges.append(element);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const label = makeSvg('text', { x: mx + 8, y: my - 8, class: 'edge-label' });
    label.textContent = String(index + 1);
    modelEdges.append(label);
    stepSegments.push({ from: line.from, to: line.to });
  });

  for (const point of allPoints.values()) {
    const isModel = candidate.points.some(item => item?.id === point.id);
    const group = makeSvg('g', { 'data-point': point.id });
    const circle = makeSvg('circle', { cx: point.x, cy: point.y, r: isModel ? 7 : 5.5, class: isModel ? 'model-node' : 'input-node' });
    const label = makeSvg('text', { x: Number(point.x) + 11, y: Number(point.y) - 10, class: 'node-label' });
    label.textContent = point.id;
    const title = makeSvg('title');
    title.textContent = `${point.id}: (${point.x}, ${point.y})`;
    group.append(circle, label, title);
    graphNodes.append(group);
  }

  const anyGraph = inputSegments.length || modelSegments.length || allPoints.size;
  graphEmpty.classList.toggle('hidden', Boolean(anyGraph));
  updateStep();
}

function updateStep() {
  const edges = [...modelEdges.querySelectorAll('.model-edge')];
  edges.forEach((edge, index) => edge.classList.toggle('active', index === activeSegment));
  const current = stepSegments[activeSegment];
  if (!current) {
    stepLabel.textContent = 'Нет сегментов ответа Qwen';
    prevStep.disabled = true;
    nextStep.disabled = true;
    return;
  }
  stepLabel.textContent = `${activeSegment + 1} / ${stepSegments.length} · ${current.from} → ${current.to}`;
  prevStep.disabled = activeSegment <= 0;
  nextStep.disabled = activeSegment >= stepSegments.length - 1;
}

function readGraphInput() {
  let parsed;
  try { parsed = JSON.parse(graphInput.value); }
  catch (error) { throw new Error(`Входной JSON повреждён: ${error.message}`); }
  if (!parsed || !Array.isArray(parsed.points) || !Array.isArray(parsed.lines)) {
    throw new Error('Во входном JSON должны быть массивы points и lines.');
  }
  return parsed;
}

function setRouteState(message, kind = '') {
  routeState.textContent = message;
  routeState.classList.remove('good', 'bad');
  if (kind) routeState.classList.add(kind);
}

function setButtonBusy(button, busy, busyLabel, normalLabel) {
  button.disabled = busy;
  button.textContent = busy ? busyLabel : normalLabel;
}

async function loadPrompts() {
  try {
    const response = await fetch('/api/prompts');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось получить промпты.');
    promptDefaults = data;
    visionPrompt.value = data.visionPrompt || '';
    routePrompt.value = data.routePrompt || '';
    modelChip.textContent = `QWEN: ${data.model || '—'}`;
    try {
      const storedVision = localStorage.getItem('jsonBrainVisionPrompt');
      const storedRoute = localStorage.getItem('jsonBrainRoutePrompt');
      if (storedVision) visionPrompt.value = storedVision;
      if (storedRoute) routePrompt.value = storedRoute;
    } catch { /* storage may be disabled */ }
  } catch (error) {
    modelChip.textContent = 'ПРОМПТЫ НЕДОСТУПНЫ';
    notify(error.message, true);
  }
}

async function checkHealth() {
  const dot = $('#apiDot');
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Health check error');
    $('#versionChip').textContent = `v${data.appVersion || '—'}`;
    if (data.ollamaReachable && data.qwenAvailable) {
      dot.classList.add('good');
      $('#apiStatus').textContent = `Ollama готова · ${data.model}`;
    } else if (data.ollamaReachable) {
      dot.classList.add('bad');
      $('#apiStatus').textContent = `Модель не найдена · ${data.model}`;
    } else {
      dot.classList.add('bad');
      $('#apiStatus').textContent = 'Нет соединения с Ollama';
    }
  } catch {
    dot.classList.add('bad');
    $('#apiStatus').textContent = 'Сервер недоступен';
  }
}

function setImage(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return notify('Выбери PNG, JPG или WEBP.', true);
  if (file.size > 15 * 1024 * 1024) return notify('Максимальный размер файла — 15 МБ.', true);
  selectedFile = file;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  sourceImage.src = objectUrl;
  sourceImage.classList.remove('hidden');
  imagePlaceholder.classList.add('hidden');
  uploadTitle.textContent = file.name;
  uploadHint.textContent = `${(file.size / 1024 / 1024).toFixed(2)} МБ · файл готов`;
  extractButton.disabled = false;
  removeImageButton.disabled = false;
}

function resetImage() {
  selectedFile = null;
  imageInput.value = '';
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  sourceImage.removeAttribute('src');
  sourceImage.classList.add('hidden');
  imagePlaceholder.classList.remove('hidden');
  uploadTitle.textContent = 'Перетащи сюда фото или выбери файл';
  uploadHint.textContent = 'PNG · JPG · WEBP · до 15 МБ';
  extractButton.disabled = true;
  removeImageButton.disabled = true;
}

function formatStats(result, elapsed) {
  return `Модель: ${result.model || '—'} · время: ${elapsed.toFixed(1)} с · done_reason: ${result.doneReason || '—'} · eval_count: ${result.evalCount ?? '—'} · prompt_eval_count: ${result.promptEvalCount ?? '—'}`;
}

extractButton.addEventListener('click', async () => {
  if (!selectedFile) return notify('Сначала выбери фото.', true);
  const selected = selectedFile;
  setButtonBusy(extractButton, true, 'Qwen анализирует фото…', '1. Извлечь точки и линии');
  extractRaw.textContent = 'Отправляю фотографию в Ollama. Жду дословный ответ…';
  setRawTab('extract');
  setRouteState('Qwen анализирует изображение; прежний OpenCV/CAD-конвейер в этой версии не вызывается.');
  const form = new FormData();
  form.append('image', selected, selected.name);
  form.append('prompt', visionPrompt.value);
  localStorage.setItem('jsonBrainVisionPrompt', visionPrompt.value);
  const started = performance.now();
  try {
    const response = await fetch('/api/qwen-extract', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Ошибка запроса Qwen.');
    extractResponse = data;
    extractRaw.textContent = data.rawContent || '(message.content пустой)';
    timing.textContent = formatStats(data, (performance.now() - started) / 1000);
    const check = {
      stage: data.stage,
      parseError: data.parseError,
      doneReason: data.doneReason,
      evalCount: data.evalCount,
      points: data.parsed?.points?.length ?? null,
      lines: data.parsed?.lines?.length ?? null,
      warnings: data.extractionWarnings || [],
      modelWarnings: data.parsed?.warnings || [],
      imageSummary: data.parsed?.image_summary || '',
    };
    checkRaw.textContent = pretty(check);
    setRawTab('extract');
    if (data.parsed && Array.isArray(data.parsed.points) && Array.isArray(data.parsed.lines)) {
      graphInput.value = pretty(data.parsed);
      const ids = data.parsed.points.map(point => point?.id).filter(id => typeof id === 'string');
      if (ids.length) {
        startIdInput.value = ids[0];
        endIdInput.value = ids.at(-1);
      }
      renderGraph(data.parsed);
      if (data.parsed.points.length && data.parsed.lines.length) {
        setRouteState(`JSON разобран: ${data.parsed.points.length} точек, ${data.parsed.lines.length} связей. Это ответ Qwen, не проверенный чертёж.`, 'good');
      } else {
        setRouteState(`Qwen вернул JSON, но граф пуст (${data.parsed.points.length} точек, ${data.parsed.lines.length} связей). Смотри Raw JSON и предупреждения — распознавание пока не выполнено.`, 'bad');
      }
    } else {
      setRouteState(`Qwen не вернул читаемый объект JSON. ${data.parseError || ''}`, 'bad');
    }
    notify(data.parsed ? 'Raw JSON Qwen получен. Проверь точки и линии до построения пути.' : 'Ответ Qwen не удалось разобрать как JSON.', !data.parsed);
  } catch (error) {
    extractRaw.textContent = error.message || String(error);
    setRouteState(error.message || 'Ошибка извлечения.', 'bad');
    notify(error.message || 'Ошибка запроса.', true);
  } finally {
    extractButton.disabled = !selectedFile;
    extractButton.textContent = '1. Извлечь точки и линии';
  }
});

routeButton.addEventListener('click', async () => {
  let graph;
  try { graph = readGraphInput(); }
  catch (error) { return notify(error.message, true); }
  setButtonBusy(routeButton, true, 'Qwen проверяет путь…', '2. Построить путь по этому JSON');
  routeRaw.textContent = 'Отправляю входной JSON и большой промпт в Ollama…';
  setRawTab('route');
  const started = performance.now();
  const request = {
    inputJson: graphInput.value,
    startId: startIdInput.value.trim(),
    endId: endIdInput.value.trim(),
    prompt: routePrompt.value,
  };
  try { localStorage.setItem('jsonBrainRoutePrompt', routePrompt.value); } catch { /* storage may be disabled */ }
  try {
    const response = await fetch('/api/qwen-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      checkRaw.textContent = pretty({ error: data.error, inputValidation: data.inputValidation });
      throw new Error(data.error || 'Ошибка построения пути.');
    }
    routeResponse = data;
    routeRaw.textContent = data.rawContent || '(message.content пустой)';
    timing.textContent = formatStats(data, (performance.now() - started) / 1000);
    const validationView = {
      model: data.model,
      parsed: data.parsed,
      parseError: data.parseError,
      inputValidation: data.inputValidation,
      localValidation: data.localValidation,
      localValidationWarnings: data.localValidation?.warnings || [],
      doneReason: data.doneReason,
      evalCount: data.evalCount,
    };
    checkRaw.textContent = pretty(validationView);
    const accepted = data.parsed?.status === 'ok' && data.inputValidation?.valid && data.localValidation?.valid;
    // Always show the model's actual candidate graph if it returned one, but mark it red unless independently valid.
    const candidate = data.parsed && Array.isArray(data.parsed.points) && Array.isArray(data.parsed.lines)
      ? data.parsed : null;
    renderGraph(graph, candidate);
    if (accepted) {
      setRouteState(`Проверка пройдена. Qwen построил ${data.parsed.lines.length} сегмент(ов); независимая длина ${data.localValidation.computedLength}.`, 'good');
    } else {
      const warnings = data.localValidation?.warnings || [data.parseError || 'Ответ не прошёл независимую проверку.'];
      setRouteState(`Ответ модели не подтверждён. ${warnings.join(' ')}`, 'bad');
    }
    setRawTab('route');
    notify(accepted ? 'Путь Qwen прошёл независимую проверку.' : 'Qwen ответил, но результат не прошёл независимую проверку.', !accepted);
  } catch (error) {
    routeRaw.textContent = routeRaw.textContent.includes('Отправляю') ? (error.message || String(error)) : routeRaw.textContent;
    if (!checkRaw.textContent.includes('error')) checkRaw.textContent = pretty({ error: error.message || String(error) });
    renderGraph(graph, null);
    setRouteState(error.message || 'Ошибка построения пути.', 'bad');
    notify(error.message || 'Ошибка построения пути.', true);
  } finally {
    routeButton.disabled = false;
    routeButton.textContent = '2. Построить путь по этому JSON';
  }
});

imageInput.addEventListener('change', event => setImage(event.target.files?.[0]));
removeImageButton.addEventListener('click', resetImage);
for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.add('drag'); });
}
for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.remove('drag'); });
}
dropzone.addEventListener('drop', event => setImage(event.dataTransfer?.files?.[0]));

$('#previewGraph').addEventListener('click', () => {
  try {
    const graph = readGraphInput();
    renderGraph(graph);
    setRouteState(`Визуализирован только входной JSON: ${graph.points.length} точек, ${graph.lines.length} связей. Qwen не вызывался.`);
    notify('Граф построен напрямую из текущих координат JSON.');
  } catch (error) { notify(error.message, true); }
});

$('#sampleGraph').addEventListener('click', () => {
  graphInput.value = pretty(sampleGraph);
  startIdInput.value = 'P1';
  endIdInput.value = 'P2';
  renderGraph(sampleGraph);
  setRouteState('Загружен контрольный граф P1 → P2. Ожидаемая длина 684.2726064953938.');
});

$('#resetVisionPrompt').addEventListener('click', () => {
  visionPrompt.value = promptDefaults.visionPrompt || '';
  try { localStorage.removeItem('jsonBrainVisionPrompt'); } catch { /* storage may be disabled */ }
  notify('Промпт извлечения восстановлен.');
});
$('#resetRoutePrompt').addEventListener('click', () => {
  routePrompt.value = promptDefaults.routePrompt || '';
  try { localStorage.removeItem('jsonBrainRoutePrompt'); } catch { /* storage may be disabled */ }
  notify('Большой промпт построения восстановлен.');
});

prevStep.addEventListener('click', () => { activeSegment = Math.max(0, activeSegment - 1); updateStep(); });
nextStep.addEventListener('click', () => { activeSegment = Math.min(stepSegments.length - 1, activeSegment + 1); updateStep(); });
document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => setRawTab(button.dataset.tab)));

$('#copyCurrent').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentOutput());
    notify('Содержимое вкладки скопировано.');
  } catch {
    const temp = document.createElement('textarea');
    temp.value = currentOutput();
    document.body.append(temp);
    temp.select();
    const ok = document.execCommand('copy');
    temp.remove();
    notify(ok ? 'Содержимое вкладки скопировано.' : 'Браузер не разрешил копирование.', !ok);
  }
});

$('#downloadCurrent').addEventListener('click', () => {
  const content = currentOutput();
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `qwen-${activeTab}-raw.json`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

$('#downloadInput').addEventListener('click', () => {
  const blob = new Blob([graphInput.value], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'input-graph.json';
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

loadPrompts();
checkHealth();
renderGraph(sampleGraph);
setRawTab('extract');
