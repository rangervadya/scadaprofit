const fileInput = document.querySelector('#fileInput');
const dropzone = document.querySelector('#dropzone');
const uploadTitle = document.querySelector('#uploadTitle');
const uploadSubtitle = document.querySelector('#uploadSubtitle');
const sourcePreviewWrap = document.querySelector('#sourcePreviewWrap');
const sourcePreview = document.querySelector('#sourcePreview');
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
const strictModeInput = document.querySelector('#strictMode');
const modeInput = document.querySelector('#mode');
const loadingHint = document.querySelector('#loadingHint');
const analysisText = document.querySelector('#analysisText');
const ocrText = document.querySelector('#ocrText');
const analysisNote = document.querySelector('#analysisNote');

let selectedFile = null;
let sourceObjectUrl = null;
let resultDataUrl = null;
let resultSvgUrl = null;
let resultDxfUrl = null;
let filenames = { png: 'cad-clean.png', svg: 'cad-trace.svg', dxf: 'cad-trace.dxf' };
let toastTimer = null;
let loadingTimer = null;

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.remove('hidden');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add('hidden'), 6200);
}

function setServiceStatus({ qwenAvailable = false, ollamaReachable = false } = {}) {
  apiDot.classList.toggle('ok', Boolean(qwenAvailable));
  apiDot.classList.toggle('bad', !qwenAvailable);
  if (qwenAvailable) apiStatus.textContent = 'Офлайн · Qwen готов';
  else if (ollamaReachable) apiStatus.textContent = 'Ollama запущен · модель не найдена';
  else apiStatus.textContent = 'Офлайн-режим · без Qwen';
}

async function checkServices() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    setServiceStatus(data);
    analysisNote.textContent = data.qwenAvailable
      ? `Локальная модель ${data.model} обнаружена. Внешний API не используется.`
      : 'OpenCV/OCR работают локально. Для анализа Qwen установите Ollama и скачайте модель qwen2.5vl:3b.';
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
  sourceName.textContent = file.name;
  uploadTitle.textContent = file.name;
  uploadSubtitle.textContent = 'Файл готов к локальной обработке';
  document.querySelector('.file-limit').textContent = `${(file.size / (1024 * 1024)).toFixed(2)} МБ · можно заменить другим файлом`;
  dropzone.classList.add('hidden');
  sourcePreviewWrap.classList.remove('hidden');
  convertButton.disabled = false;
  clearResult();
}

function resetSource() {
  selectedFile = null;
  fileInput.value = '';
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = null;
  sourcePreview.removeAttribute('src');
  sourcePreviewWrap.classList.add('hidden');
  dropzone.classList.remove('hidden');
  uploadTitle.textContent = 'Перетащите фото сюда';
  uploadSubtitle.innerHTML = 'или <span class="text-link">выберите файл</span> на устройстве';
  document.querySelector('.file-limit').textContent = 'Максимальный размер файла — 15 МБ';
  convertButton.disabled = true;
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
  resultTag.classList.remove('ready');
  resultMeta.textContent = 'PNG · SVG · DXF';
  analysisText.textContent = 'После обработки здесь появится анализ Qwen, если локальная модель установлена.';
  ocrText.textContent = 'После обработки появятся найденные подписи и цифры.';
}

function startLoading() {
  emptyState.classList.add('hidden');
  resultImageWrap.classList.add('hidden');
  loadingState.classList.remove('hidden');
  resultTag.textContent = 'ОБРАБОТКА';
  resultTag.classList.remove('ready');
  convertButton.disabled = true;
  convertButtonText.textContent = 'Идёт локальная обработка…';
  downloadButton.disabled = true;
  downloadSvgButton.disabled = true;
  downloadDxfButton.disabled = true;
  const hints = [
    modeInput?.value === 'cad' ? 'Qwen анализирует компоновку и восстанавливает схему в CAD-стиле.' : 'OpenCV очищает фон и выравнивает контраст.',
    'Tesseract пытается распознать подписи и числовые обозначения.',
    modeInput?.value === 'cad' ? 'Строим чистовой векторный лист с ровными линиями и условными знаками.' : 'Строим контуры для SVG и DXF.',
    'Выполняем локальную обработку; размеры и соединения потом нужно проверить.'
  ];
  let index = 0;
  loadingHint.textContent = hints[index];
  loadingTimer = window.setInterval(() => {
    index = (index + 1) % hints.length;
    loadingHint.textContent = hints[index];
  }, 3800);
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
    formData.append('strictMode', String(strictModeInput.checked));
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
    resultTag.textContent = 'ГОТОВО';
    resultTag.classList.add('ready');
    resultMeta.textContent = data.mode === 'cad' && data.stats?.routes
      ? `${data.stats.routes} трасс · ${data.stats.symbols || 0} символов · ${data.stats.labels || 0} подписей · ${data.stats.sheet || 'CAD'}`
      : `${data.stats?.width || '?'} × ${data.stats?.height || '?'} px · ${data.stats?.contours || '?'} контуров · ${data.stats?.sheet || 'A4'}`;
    downloadButton.disabled = false;
    downloadSvgButton.disabled = false;
    downloadDxfButton.disabled = false;
    analysisText.textContent = data.analysis || 'Qwen-анализ не выполнен. PNG/SVG/DXF и OCR обработаны локально.';
    ocrText.textContent = data.ocrText || 'Надписи не найдены.';
    analysisNote.textContent = [data.note, data.analysisNotice].filter(Boolean).join(' ');
    if (data.qwenAvailable) setServiceStatus({ qwenAvailable: true, ollamaReachable: true });
    showToast(data.cadReconstructed ? 'CAD-реконструкция создана локально. Обязательно проверьте подписи, размеры и соединения.' : data.analysisNotice ? 'Qwen не смог перестроить схему; показан резервный результат очистки.' : data.qwenAvailable ? 'Готово. Проверьте размеры и соединения.' : 'Векторизация готова без Qwen. Проверьте результат.', Boolean(data.analysisNotice) || !data.qwenAvailable || (data.mode === 'cad' && !data.cadReconstructed));
  } catch (error) {
    emptyState.classList.remove('hidden');
    resultTag.textContent = 'ОШИБКА';
    showToast(error.message || 'Не удалось выполнить локальную обработку.', true);
  } finally {
    stopLoading();
  }
});

downloadButton.addEventListener('click', () => downloadUrl(resultDataUrl, filenames.png));
downloadSvgButton.addEventListener('click', () => downloadUrl(resultSvgUrl, filenames.svg));
downloadDxfButton.addEventListener('click', () => downloadUrl(resultDxfUrl, filenames.dxf));

checkServices();
