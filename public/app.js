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
const inkMode = $('#inkMode');
const minConfidence = $('#minConfidence');
const padding = $('#padding');
const confidenceValue = $('#confidenceValue');
const paddingValue = $('#paddingValue');
const toast = $('#toast');

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

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function setBusy(busy) {
  processButton.disabled = busy || !selectedFile;
  processButton.textContent = busy ? 'Строю две маски…' : 'Построить две маски';
  removeImageButton.disabled = busy || !selectedFile;
}

function setImage(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    notify('Поддерживаются PNG, JPG и WEBP.', true);
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    notify('Максимальный размер файла — 15 МБ.', true);
    return;
  }
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
  $('#statSize').textContent = '—';
  $('#statInk').textContent = '—';
  $('#statOcr').textContent = '—';
  $('#statText').textContent = '—';
  $('#statLines').textContent = '—';
  $('#statTime').textContent = '—';
  $('#debugOutput').textContent = 'Здесь появятся числа, подписи и уверенность OCR.';
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

function dataUrl(base64) {
  return `data:image/png;base64,${base64}`;
}

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
  $('#statOcr').textContent = String(stats.ocrBoxes ?? 0);
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
    appVersion: '3.0.0',
    dimensions: { width: result.width, height: result.height },
    mode: result.mode,
    stats,
    warnings: result.warnings || [],
    recognizedTextBoxes: result.boxes || [],
    maskDefinition: {
      text: 'Original ink pixels inside the padded OCR word bounding boxes.',
      lines: 'All other original ink pixels outside those OCR word boxes.',
      note: 'No lines are synthesized, joined, smoothed, or interpreted as pipes.',
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
  const form = new FormData();
  form.append('image', selectedFile, selectedFile.name);
  form.append('mode', inkMode.value);
  form.append('minConfidence', minConfidence.value);
  form.append('padding', padding.value);
  const started = performance.now();
  try {
    const response = await fetch('/api/masks', { method: 'POST', body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `Ошибка обработки (${response.status}).`);
    renderResult(result);
    const stats = result.stats || {};
    notify(`Две маски готовы. OCR-областей: ${stats.ocrBoxes ?? 0}; чернила: ${Number(stats.inkPixels || 0).toLocaleString('ru-RU')} пикселей.`);
    if ((performance.now() - started) > 45000) notify('Обработка завершилась, но заняла больше 45 секунд.');
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
for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.add('drag'); });
}
for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.remove('drag'); });
}
dropzone.addEventListener('drop', event => setImage(event.dataTransfer?.files?.[0]));

minConfidence.addEventListener('input', () => { confidenceValue.value = minConfidence.value; });
padding.addEventListener('input', () => { paddingValue.value = `${padding.value} px`; });

async function checkHealth() {
  const dot = $('#apiDot');
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Health check error');
    $('#versionChip').textContent = `v${data.appVersion || '—'}`;
    dot.classList.add('good');
    $('#apiStatus').textContent = 'Локальный OpenCV + Tesseract · Qwen не вызывается';
  } catch {
    dot.classList.add('bad');
    $('#apiStatus').textContent = 'Локальный обработчик недоступен';
  }
}

imageInput.value = '';
checkHealth();
