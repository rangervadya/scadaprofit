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
const preserveDetailsInput = document.querySelector('#strictMode');
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
let filenames = { png: 'cad-vector-preview.png', svg: 'cad-centerline-trace.svg', dxf: 'cad-centerline-trace.dxf' };
let toastTimer = null;
let loadingTimer = null;

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
  resultTag.classList.remove('ready', 'review');
  resultMeta.textContent = 'PNG · SVG · DXF';
  analysisText.textContent = 'После обработки здесь появится статистика трассировки OpenCV.';
  ocrText.textContent = 'После обработки появятся кандидаты OCR. Текст нужно сверить вручную.';
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

checkServices();
