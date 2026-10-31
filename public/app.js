const $ = selector => document.querySelector(selector);

const imageInput = $('#imageInput');
const dropzone = $('#dropzone');
const uploadTitle = $('#uploadTitle');
const uploadHint = $('#uploadHint');
const processButton = $('#processButton');
const removeImageButton = $('#removeImage');
const sourceImage = $('#sourceImage');
const sourceSelectCanvas = $('#sourceSelectCanvas');
const textMaskImage = $('#textMaskImage');
const lineMaskImage = $('#lineMaskImage');
const vectorLinesImage = $('#vectorLinesImage');
const cleanDrawingImage = $('#cleanDrawingImage');
const vectorPlaceholder = $('#vectorPlaceholder');
const textPlaceholder = $('#textPlaceholder');
const linePlaceholder = $('#linePlaceholder');
const toast = $('#toast');

const defaults = {
  inkMode: 'blue', minConfidence: 35, ocrScale: '2', preprocess: 'original', psm: '11', language: 'eng+rus',
  padding: 1, paddingRatio: 0, minBoxWidth: 4, minBoxHeight: 3,
  hueMin: 90, hueMax: 145, hueTolerance: 24, saturationMin: 18,
  minBrightness: 20, maxBrightness: 252, darkThreshold: 132, minComponentArea: 2,
  previewScale: 3, vectorTolerance: 0.8, vectorSmoothing: 30, cornerProtection: 90,
  vectorStrokeWidth: 2, minVectorLength: 1.5, labelMinConfidence: 0,
};

const presets = {
  balanced: { ...defaults },
  moreText: { ...defaults, minConfidence: 15, ocrScale: '3', padding: 2, paddingRatio: 4, minBoxWidth: 2, minBoxHeight: 2, saturationMin: 8 },
  protectLines: { ...defaults, minConfidence: 65, ocrScale: '2', padding: 0, paddingRatio: 0, minBoxWidth: 6, minBoxHeight: 5, minComponentArea: 1 },
  strict: { ...defaults, minConfidence: 55, ocrScale: '2.5', preprocess: 'clahe', padding: 1, paddingRatio: 0, minBoxWidth: 5, minBoxHeight: 4 },
};

const fields = [
  'inkMode', 'minConfidence', 'ocrScale', 'preprocess', 'psm', 'language', 'padding', 'paddingRatio',
  'minBoxWidth', 'minBoxHeight', 'hueMin', 'hueMax', 'hueTolerance', 'saturationMin',
  'minBrightness', 'maxBrightness', 'darkThreshold', 'minComponentArea',
  'previewScale', 'vectorTolerance', 'vectorSmoothing', 'cornerProtection', 'vectorStrokeWidth', 'minVectorLength', 'labelMinConfidence',
];
const unitLabels = {
  padding: value => `${value} px`, paddingRatio: value => `${value}%`,
  minBoxWidth: value => `${value} px`, minBoxHeight: value => `${value} px`,
  ocrScale: value => `${value}×`, previewScale: value => `${value}×`,
  vectorTolerance: value => `${Number(value).toLocaleString('ru-RU')} px`,
  vectorSmoothing: value => `${value}%`, cornerProtection: value => `${value}%`,
  vectorStrokeWidth: value => `${Number(value).toLocaleString('ru-RU')} px`,
  minVectorLength: value => `${Number(value).toLocaleString('ru-RU')} px`,
  labelMinConfidence: value => `${value}`,
};

let selectedFile = null;
let sourceUrl = null;
let maskResult = null;
let labelState = [];
let manualSelectMode = false;
let manualDragStart = null;
let manualDragCurrent = null;
let toastTimer = null;

function notify(message, isError = false) {
  toast.textContent = message;
  toast.classList.remove('hidden', 'error');
  if (isError) toast.classList.add('error');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 5500);
}

function pretty(value) { return JSON.stringify(value, null, 2); }

function currentSettings() {
  const settings = {};
  for (const id of fields) {
    const element = $(`#${id}`);
    settings[id] = element.type === 'range' ? Number(element.value) : element.value;
  }
  return settings;
}

function updateSettingLabels() {
  for (const id of fields) {
    const input = $(`#${id}`);
    const output = $(`#${id === 'minConfidence' ? 'confidenceValue' : `${id}Value`}`);
    if (!input || !output || input.type !== 'range') continue;
    const formatter = unitLabels[id];
    output.textContent = formatter ? formatter(input.value) : input.value;
  }
  const confidence = Number($('#minConfidence').value);
  const hint = confidence < 20
    ? 'Низкий порог: много кандидатов, включая ошибочные символы и части труб.'
    : confidence < 50
      ? 'Средний порог: компромисс между количеством текста и ложными OCR-областями.'
      : 'Высокий порог: остаются только более уверенные распознавания; рукописные цифры могут пропасть.';
  $('#confidenceHint').textContent = hint;
}

function setSettings(values, activePreset = null) {
  for (const [key, value] of Object.entries(values)) {
    const el = $(`#${key}`);
    if (el) el.value = String(value);
  }
  document.querySelectorAll('[data-preset]').forEach(button => {
    button.classList.toggle('active', button.dataset.preset === activePreset);
  });
  updateSettingLabels();
}

function setBusy(busy) {
  processButton.disabled = busy || !selectedFile;
  processButton.textContent = busy ? 'Обрабатываю…' : 'Построить две маски';
  removeImageButton.disabled = busy || !selectedFile;
  $('#toggleManualRegion').disabled = busy || !selectedFile;
}

function clearResults() {
  maskResult = null;
  textMaskImage.removeAttribute('src');
  lineMaskImage.removeAttribute('src');
  vectorLinesImage.removeAttribute('src');
  cleanDrawingImage.removeAttribute('src');
  labelState = [];
  $('#cleanDrawingImage').classList.add('hidden');
  $('#cleanPlaceholder').classList.remove('hidden');
  $('#downloadClean').classList.add('hidden');
  $('#cleanStats').textContent = 'Печатные подписи ещё не сформированы.';
  $('#labelList').innerHTML = '<p class="empty-labels">Сначала построй две маски.</p>';
  $('#labelCount').textContent = '0';
  $('#applyLabels').disabled = true;
  vectorLinesImage.classList.add('hidden');
  vectorPlaceholder.classList.remove('hidden');
  $('#downloadVector').classList.add('hidden');
  $('#vectorStats').textContent = 'Векторизация ещё не выполнялась.';
  textMaskImage.classList.add('hidden');
  lineMaskImage.classList.add('hidden');
  textPlaceholder.classList.remove('hidden');
  linePlaceholder.classList.remove('hidden');
  $('#downloadText').classList.add('hidden');
  $('#downloadLines').classList.add('hidden');
  $('#downloadRow').classList.add('hidden');
  $('#warnings').classList.add('hidden');
  $('#resultTag').textContent = 'ОЖИДАНИЕ';
  ['statSize', 'statInk', 'statOcr', 'statText', 'statLines', 'statTime'].forEach(id => $(`#${id}`).textContent = '—');
  $('#debugOutput').textContent = 'Здесь появятся числа, подписи и уверенность OCR.';
}

function setImage(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return notify('Поддерживаются PNG, JPG и WEBP.', true);
  if (file.size > 15 * 1024 * 1024) return notify('Максимальный размер файла — 15 МБ.', true);
  selectedFile = file;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(file);
  sourceImage.src = sourceUrl;
  sourceImage.classList.remove('hidden');
  $('#sourceView .placeholder').classList.add('hidden');
  uploadTitle.textContent = file.name;
  uploadHint.textContent = `${(file.size / 1024 / 1024).toFixed(2)} МБ · готов к обработке`;
  processButton.disabled = false;
  removeImageButton.disabled = false;
  $('#toggleManualRegion').disabled = false;
  setManualSelectMode(false);
  clearResults();
}

function removeImage() {
  selectedFile = null;
  imageInput.value = '';
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = null;
  sourceImage.removeAttribute('src');
  sourceImage.classList.add('hidden');
  $('#sourceView .placeholder').classList.remove('hidden');
  uploadTitle.textContent = 'Перетащи фото сюда или выбери файл';
  uploadHint.textContent = 'PNG · JPG · WEBP · до 15 МБ';
  processButton.disabled = true;
  removeImageButton.disabled = true;
  $('#toggleManualRegion').disabled = true;
  setManualSelectMode(false);
  clearResults();
}

function dataUrl(base64) { return `data:image/png;base64,${base64}`; }
function svgDataUrl(base64) { return `data:image/svg+xml;base64,${base64}`; }

function saveDownload(anchor, base64) {
  anchor.href = dataUrl(base64);
  anchor.classList.remove('hidden');
}

function makeLabelRow(label, index) {
  const row = document.createElement('div');
  row.className = 'label-row';
  const useMask = document.createElement('input');
  useMask.type = 'checkbox';
  useMask.checked = label.mask !== false;
  useMask.title = 'Убрать рукописные пиксели из слоя линий';
  useMask.addEventListener('change', () => {
    labelState[index].mask = useMask.checked;
    if (!useMask.checked) {
      labelState[index].render = false;
      printText.checked = false;
    }
  });

  const text = document.createElement('input');
  text.type = 'text';
  text.value = label.text || '';
  text.maxLength = 100;
  text.placeholder = 'Исправь OCR или введи точный размер';
  text.setAttribute('aria-label', `Текст подписи ${index + 1}`);
  text.addEventListener('input', () => { labelState[index].text = text.value; });

  const printText = document.createElement('input');
  printText.type = 'checkbox';
  printText.checked = label.render === true;
  printText.title = 'Вывести исправленный текст печатным шрифтом в чистом SVG';
  printText.addEventListener('change', () => {
    labelState[index].render = printText.checked;
    if (printText.checked && !useMask.checked) {
      useMask.checked = true;
      labelState[index].mask = true;
    }
  });

  const confidence = document.createElement('span');
  confidence.className = 'label-confidence';
  confidence.textContent = `${Math.round(Number(label.confidence || 0))}%`;

  const rotation = document.createElement('input');
  rotation.type = 'number';
  rotation.min = '-180'; rotation.max = '180'; rotation.step = '1';
  rotation.value = String(label.rotation || 0);
  rotation.title = 'Угол поворота печатной подписи';
  rotation.addEventListener('input', () => { labelState[index].rotation = Math.max(-180, Math.min(180, Number(rotation.value) || 0)); });

  const coords = document.createElement('span');
  coords.className = 'coords';
  coords.textContent = `#${index + 1} · x=${label.x}, y=${label.y}, w=${label.width}, h=${label.height}`;
  const main = document.createElement('div');
  main.className = 'label-row-main';
  main.append(useMask, text, printText, confidence, rotation);
  const crop = document.createElement('canvas');
  crop.className = 'label-crop';
  crop.width = 260; crop.height = 72;
  const ctx = crop.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, crop.width, crop.height);
  if (sourceImage.complete && sourceImage.naturalWidth) {
    const pad = 6;
    const sx = Math.max(0, label.x - pad), sy = Math.max(0, label.y - pad);
    const sw = Math.min(sourceImage.naturalWidth - sx, label.width + pad * 2);
    const sh = Math.min(sourceImage.naturalHeight - sy, label.height + pad * 2);
    if (sw > 0 && sh > 0) {
      const scale = Math.min((crop.width - 12) / sw, (crop.height - 12) / sh, 4);
      const dw = sw * scale, dh = sh * scale;
      ctx.drawImage(sourceImage, sx, sy, sw, sh, (crop.width - dw) / 2, (crop.height - dh) / 2, dw, dh);
    }
  }
  const lower = document.createElement('div');
  lower.className = 'label-row-lower';
  lower.append(coords, crop);
  row.append(main, lower);
  return row;
}

function renderLabelEditor(boxes = []) {
  labelState = (boxes || []).map((box, index) => ({
    id: index, text: String(box.text || ''), confidence: Number(box.confidence || 0),
    x: Number(box.x || 0), y: Number(box.y || 0),
    width: Number(box.width || 1), height: Number(box.height || 1),
    rotation: Number(box.rotation || 0), fontScale: Number(box.fontScale || 0.9),
    mask: box.mask !== false, render: box.render === true, manual: box.manual === true,
  }));
  const list = $('#labelList');
  list.replaceChildren();
  if (!labelState.length) {
    list.innerHTML = '<p class="empty-labels">OCR не нашёл текстовых областей. Можно продолжать со слоем линий.</p>';
  } else {
    labelState.forEach((label, index) => list.append(makeLabelRow(label, index)));
  }
  $('#labelCount').textContent = String(labelState.length);
  $('#applyLabels').disabled = !selectedFile || !labelState.length;
}

async function applyLabelEdits() {
  if (!selectedFile || !maskResult) return;
  setBusy(true);
  $('#applyLabels').disabled = true;
  $('#resultTag').textContent = 'ПЕРЕСБОРКА ПОДПИСЕЙ…';
  const form = new FormData();
  form.append('image', selectedFile, selectedFile.name);
  for (const [key, value] of Object.entries(currentSettings())) form.append(key === 'inkMode' ? 'mode' : key, String(value));
  form.append('overrideBoxes', JSON.stringify(labelState));
  const started = performance.now();
  try {
    const response = await fetch('/api/masks', { method: 'POST', body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `Ошибка пересборки (${response.status}).`);
    result.elapsedMs = result.elapsedMs || (performance.now() - started);
    renderResult(result);
    notify('Маски пересобраны. Печатный текст добавлен только для отмеченных проверенных подписей.');
  } catch (error) {
    notify(error.message || 'Не удалось применить подписи.', true);
  } finally {
    setBusy(false);
    $('#applyLabels').disabled = !labelState.length;
  }
}

function renderResult(result) {
  maskResult = result;
  // Display uses antialiased supersampled previews; downloads remain exact binary masks.
  textMaskImage.src = dataUrl(result.masks.textPreviewPngBase64 || result.masks.textPngBase64);
  lineMaskImage.src = dataUrl(result.masks.linesPreviewPngBase64 || result.masks.linesPngBase64);
  textMaskImage.classList.remove('hidden');
  lineMaskImage.classList.remove('hidden');
  textPlaceholder.classList.add('hidden');
  linePlaceholder.classList.add('hidden');

  if (result.masks.lineSvgBase64) {
    vectorLinesImage.src = svgDataUrl(result.masks.lineSvgBase64);
    vectorLinesImage.classList.remove('hidden');
    vectorPlaceholder.classList.add('hidden');
    $('#downloadVector').href = svgDataUrl(result.masks.lineSvgBase64);
    $('#downloadVector').classList.remove('hidden');
  } else {
    vectorLinesImage.classList.add('hidden');
    vectorPlaceholder.classList.remove('hidden');
  }

  if (result.masks.cleanSvgBase64) {
    const cleanUrl = svgDataUrl(result.masks.cleanSvgBase64);
    cleanDrawingImage.src = cleanUrl;
    cleanDrawingImage.classList.remove('hidden');
    $('#cleanPlaceholder').classList.add('hidden');
    $('#downloadClean').href = cleanUrl;
    $('#downloadClean').classList.remove('hidden');
  } else {
    cleanDrawingImage.classList.add('hidden');
    $('#cleanPlaceholder').classList.remove('hidden');
    $('#downloadClean').classList.add('hidden');
  }
  const cleanTextInfo = result.cleanText || {};
  $('#cleanStats').textContent = `Печатных надписей: ${cleanTextInfo.renderedLabels ?? 0} · пропущено: ${cleanTextInfo.skippedLabels ?? 0} · шрифт: ${cleanTextInfo.fontFamily || 'Arial'}. Исправляй текст в списке ниже; повторная обработка OCR не выполняется.`;
  renderLabelEditor(result.boxes || []);

  const stats = result.stats || {};
  $('#resultTag').textContent = result.warnings?.length ? 'ГОТОВО · ЕСТЬ ЗАМЕЧАНИЯ' : 'МАСКИ ГОТОВЫ';
  $('#statSize').textContent = `${result.width} × ${result.height}`;
  $('#statInk').textContent = Number(stats.inkPixels || 0).toLocaleString('ru-RU');
  $('#statOcr').textContent = `${stats.ocrBoxes ?? 0} / ${stats.ocrRawWords ?? 0}`;
  $('#statText').textContent = `${Number(stats.textPixels || 0).toLocaleString('ru-RU')} · ${stats.textCoveragePercent ?? 0}%`;
  $('#statLines').textContent = `${Number(stats.linePixels || 0).toLocaleString('ru-RU')} · ${stats.lineCoveragePercent ?? 0}%`;
  $('#statTime').textContent = `${((result.elapsedMs || 0) / 1000).toFixed(2)} с`;
  const vector = result.vectorization || {};
  $('#vectorStats').textContent = `Скелет: ${Number(vector.skeletonPixels || 0).toLocaleString('ru-RU')} px · путей найдено: ${vector.tracedPaths ?? 0} · SVG-путей: ${vector.vectorPaths ?? 0} · длина: ${vector.vectorLengthPx ?? 0} px · допуск: ${vector.simplifyTolerancePx ?? 0} px · сглаживание: ${vector.smoothingPercent ?? 0}%`;

  saveDownload($('#downloadText'), result.masks.textPngBase64);
  saveDownload($('#downloadLines'), result.masks.linesPngBase64);
  $('#downloadRow').classList.remove('hidden');
  $('#downloadInk').href = dataUrl(result.masks.inkPngBase64);
  $('#downloadOverlay').href = dataUrl(result.masks.overlayPngBase64);

  const warningBox = $('#warnings');
  warningBox.replaceChildren();
  for (const warning of result.warnings || []) {
    const item = document.createElement('p');
    item.textContent = warning;
    warningBox.append(item);
  }
  if (result.warnings?.length) warningBox.classList.remove('hidden');
  else warningBox.classList.add('hidden');

  const report = {
    appVersion: '3.3.0', dimensions: { width: result.width, height: result.height },
    settings: result.settings, mode: result.mode, ocr: result.ocr, stats,
    warnings: result.warnings || [], recognizedTextBoxes: result.boxes || [],
    vectorization: result.vectorization || {}, cleanText: result.cleanText || {},
    labelsAfterEdit: labelState,
    maskDefinition: {
      text: 'Original ink pixels inside OCR word boxes after explicit pixel + proportional padding.',
      lines: 'All other original ink pixels outside those OCR word boxes.',
      note: 'Original 1x binary masks are unchanged. Clean SVG combines centerline paths with editable typeset labels. OCR errors need manual correction; no handwriting recognition accuracy is guaranteed.',
    },
  };
  $('#debugOutput').textContent = pretty(report);
  $('#downloadReport').onclick = () => downloadText('two-mask-report.json', pretty(report), 'application/json;charset=utf-8');
}

function downloadText(filename, content, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

processButton.addEventListener('click', async () => {
  if (!selectedFile) return notify('Сначала выбери фотографию.', true);
  setBusy(true);
  $('#resultTag').textContent = 'ОБРАБОТКА…';
  const settings = currentSettings();
  const form = new FormData();
  form.append('image', selectedFile, selectedFile.name);
  for (const [key, value] of Object.entries(settings)) form.append(key === 'inkMode' ? 'mode' : key, String(value));
  const started = performance.now();
  try {
    const response = await fetch('/api/masks', { method: 'POST', body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `Ошибка обработки (${response.status}).`);
    result.elapsedMs = result.elapsedMs || (performance.now() - started);
    renderResult(result);
    const stats = result.stats || {};
    notify(`Маски готовы. OCR: ${stats.ocrBoxes ?? 0} из ${stats.ocrRawWords ?? 0} кандидатов; текст ${stats.textCoveragePercent ?? 0}%; линии ${stats.lineCoveragePercent ?? 0}%.`);
  } catch (error) {
    $('#resultTag').textContent = 'ОШИБКА';
    notify(error.message || 'Не удалось построить маски.', true);
    $('#warnings').textContent = error.message || String(error);
    $('#warnings').classList.remove('hidden');
  } finally {
    setBusy(false);
  }
});

imageInput.addEventListener('change', event => setImage(event.target.files?.[0]));
removeImageButton.addEventListener('click', removeImage);
for (const eventName of ['dragenter', 'dragover']) dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.add('drag'); });
for (const eventName of ['dragleave', 'drop']) dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.remove('drag'); });
dropzone.addEventListener('drop', event => setImage(event.dataTransfer?.files?.[0]));

for (const id of fields.filter(id => $(`#${id}`)?.type === 'range')) {
  $(`#${id}`).addEventListener('input', () => {
    updateSettingLabels();
    document.querySelectorAll('[data-preset]').forEach(button => button.classList.remove('active'));
  });
}
document.querySelectorAll('[data-preset]').forEach(button => {
  button.addEventListener('click', () => setSettings(presets[button.dataset.preset], button.dataset.preset));
});
document.querySelectorAll('.settings select').forEach(select => {
  select.addEventListener('change', () => document.querySelectorAll('[data-preset]').forEach(button => button.classList.remove('active')));
});
$('#resetSettings').addEventListener('click', () => setSettings(defaults, 'balanced'));

$('#applyLabels').addEventListener('click', applyLabelEdits);

function setManualSelectMode(enabled) {
  manualSelectMode = Boolean(enabled && selectedFile);
  manualDragStart = null;
  manualDragCurrent = null;
  $('#sourceView').classList.toggle('selecting', manualSelectMode);
  $('#toggleManualRegion').classList.toggle('button-primary', manualSelectMode);
  $('#toggleManualRegion').textContent = manualSelectMode ? 'Завершить выделение' : 'Выделить надпись на фото';
  $('#selectionHint').textContent = manualSelectMode
    ? 'Зажми левую кнопку мыши и обведи область с рукописью. Отпусти, чтобы добавить её в список.'
    : 'Можно обвести цифры/буквы, которые OCR пропустил.';
  drawSelectionCanvas();
}

function imagePointFromClient(clientX, clientY) {
  if (!sourceImage.naturalWidth || !sourceImage.naturalHeight) return null;
  const rect = sourceSelectCanvas.getBoundingClientRect();
  const scale = Math.min(rect.width / sourceImage.naturalWidth, rect.height / sourceImage.naturalHeight);
  const shownW = sourceImage.naturalWidth * scale;
  const shownH = sourceImage.naturalHeight * scale;
  const offsetX = (rect.width - shownW) / 2;
  const offsetY = (rect.height - shownH) / 2;
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  if (localX < offsetX || localY < offsetY || localX > offsetX + shownW || localY > offsetY + shownH) return null;
  return {
    x: Math.max(0, Math.min(sourceImage.naturalWidth, (localX - offsetX) / scale)),
    y: Math.max(0, Math.min(sourceImage.naturalHeight, (localY - offsetY) / scale)),
    screenX: localX, screenY: localY,
  };
}

function drawSelectionCanvas() {
  const canvas = sourceSelectCanvas;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const targetWidth = Math.round(rect.width * dpr);
  const targetHeight = Math.round(rect.height * dpr);
  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!manualDragStart || !manualDragCurrent) return;
  const x = Math.min(manualDragStart.screenX, manualDragCurrent.screenX);
  const y = Math.min(manualDragStart.screenY, manualDragCurrent.screenY);
  const w = Math.abs(manualDragStart.screenX - manualDragCurrent.screenX);
  const h = Math.abs(manualDragStart.screenY - manualDragCurrent.screenY);
  ctx.fillStyle = 'rgba(215,122,36,.16)';
  ctx.strokeStyle = '#d77a24';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

$('#toggleManualRegion').addEventListener('click', () => setManualSelectMode(!manualSelectMode));
sourceSelectCanvas.addEventListener('pointerdown', event => {
  if (!manualSelectMode) return;
  const point = imagePointFromClient(event.clientX, event.clientY);
  if (!point) return;
  manualDragStart = point;
  manualDragCurrent = point;
  sourceSelectCanvas.setPointerCapture(event.pointerId);
  drawSelectionCanvas();
});
sourceSelectCanvas.addEventListener('pointermove', event => {
  if (!manualSelectMode || !manualDragStart) return;
  manualDragCurrent = imagePointFromClient(event.clientX, event.clientY) || manualDragCurrent;
  drawSelectionCanvas();
});
sourceSelectCanvas.addEventListener('pointerup', event => {
  if (!manualSelectMode || !manualDragStart || !manualDragCurrent) return;
  const x = Math.floor(Math.min(manualDragStart.x, manualDragCurrent.x));
  const y = Math.floor(Math.min(manualDragStart.y, manualDragCurrent.y));
  const width = Math.ceil(Math.abs(manualDragStart.x - manualDragCurrent.x));
  const height = Math.ceil(Math.abs(manualDragStart.y - manualDragCurrent.y));
  manualDragStart = null;
  manualDragCurrent = null;
  drawSelectionCanvas();
  if (width < 4 || height < 4) {
    notify('Область слишком маленькая. Обведи надпись чуть крупнее.', true);
    return;
  }
  labelState.push({
    id: labelState.length, text: '', confidence: 100, x, y, width, height,
    rotation: 0, fontScale: 0.9, mask: true, render: false, manual: true,
  });
  renderLabelEditor(labelState);
  $('#labelEditorDetails').open = true;
  notify('Рукописная область добавлена. Введи аккуратный текст и включи «Печатать», если он нужен в чистом SVG.');
});
window.addEventListener('resize', drawSelectionCanvas);

async function checkHealth() {
  const dot = $('#apiDot');
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Health check error');
    $('#versionChip').textContent = `v${data.appVersion || '—'}`;
    dot.classList.add('good');
    $('#apiStatus').textContent = 'Локальный Две маски + редактор печатных подписей · Qwen не вызывается';
  } catch {
    dot.classList.add('bad');
    $('#apiStatus').textContent = 'Локальный обработчик недоступен';
  }
}

imageInput.value = '';
setSettings(defaults, 'balanced');
checkHealth();
