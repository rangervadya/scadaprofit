const $ = selector => document.querySelector(selector);

const imageInput = $('#imageInput');
const dropzone = $('#dropzone');
const uploadTitle = $('#uploadTitle');
const uploadHint = $('#uploadHint');
const processButton = $('#processButton');
const removeImageButton = $('#removeImage');
const sourceImage = $('#sourceImage');
const textMaskImage = $('#textMaskImage');
const lineMaskImage = $('#lineMaskImage');
const textPlaceholder = $('#textPlaceholder');
const linePlaceholder = $('#linePlaceholder');
const toast = $('#toast');

const defaults = {
  inkMode: 'blue', minConfidence: 35, ocrScale: '2', preprocess: 'original', psm: '11', language: 'eng+rus',
  padding: 1, paddingRatio: 0, minBoxWidth: 4, minBoxHeight: 3,
  hueMin: 90, hueMax: 145, hueTolerance: 24, saturationMin: 18,
  minBrightness: 20, maxBrightness: 252, darkThreshold: 132, minComponentArea: 2,
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
];
const unitLabels = {
  padding: value => `${value} px`, paddingRatio: value => `${value}%`,
  minBoxWidth: value => `${value} px`, minBoxHeight: value => `${value} px`,
  ocrScale: value => `${value}×`,
};

let selectedFile = null;
let sourceUrl = null;
let maskResult = null;
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
}

function clearResults() {
  maskResult = null;
  textMaskImage.removeAttribute('src');
  lineMaskImage.removeAttribute('src');
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
  clearResults();
}

function dataUrl(base64) { return `data:image/png;base64,${base64}`; }

function saveDownload(anchor, base64) {
  anchor.href = dataUrl(base64);
  anchor.classList.remove('hidden');
}

function renderResult(result) {
  maskResult = result;
  textMaskImage.src = dataUrl(result.masks.textPngBase64);
  lineMaskImage.src = dataUrl(result.masks.linesPngBase64);
  textMaskImage.classList.remove('hidden');
  lineMaskImage.classList.remove('hidden');
  textPlaceholder.classList.add('hidden');
  linePlaceholder.classList.add('hidden');

  const stats = result.stats || {};
  $('#resultTag').textContent = result.warnings?.length ? 'ГОТОВО · ЕСТЬ ЗАМЕЧАНИЯ' : 'МАСКИ ГОТОВЫ';
  $('#statSize').textContent = `${result.width} × ${result.height}`;
  $('#statInk').textContent = Number(stats.inkPixels || 0).toLocaleString('ru-RU');
  $('#statOcr').textContent = `${stats.ocrBoxes ?? 0} / ${stats.ocrRawWords ?? 0}`;
  $('#statText').textContent = `${Number(stats.textPixels || 0).toLocaleString('ru-RU')} · ${stats.textCoveragePercent ?? 0}%`;
  $('#statLines').textContent = `${Number(stats.linePixels || 0).toLocaleString('ru-RU')} · ${stats.lineCoveragePercent ?? 0}%`;
  $('#statTime').textContent = `${((result.elapsedMs || 0) / 1000).toFixed(2)} с`;

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
    appVersion: '3.1.0', dimensions: { width: result.width, height: result.height },
    settings: result.settings, mode: result.mode, ocr: result.ocr, stats,
    warnings: result.warnings || [], recognizedTextBoxes: result.boxes || [],
    maskDefinition: {
      text: 'Original ink pixels inside OCR word boxes after explicit pixel + proportional padding.',
      lines: 'All other original ink pixels outside those OCR word boxes.',
      note: 'The original ink mask is partitioned without line synthesis, joining or geometry inference.',
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

async function checkHealth() {
  const dot = $('#apiDot');
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Health check error');
    $('#versionChip').textContent = `v${data.appVersion || '—'}`;
    dot.classList.add('good');
    $('#apiStatus').textContent = 'Локальный OpenCV + настраиваемый Tesseract · Qwen не вызывается';
  } catch {
    dot.classList.add('bad');
    $('#apiStatus').textContent = 'Локальный обработчик недоступен';
  }
}

imageInput.value = '';
setSettings(defaults, 'balanced');
checkHealth();
