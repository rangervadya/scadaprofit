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
let activeJoinId = null;
let activeJoinGroupNode = null;
let addressLibrary = { streets: [] };
let selectedStreetId = null;
let selectedBuildingId = null;
let selectedJobId = null;
let activeScheme = null;
let schemePollToken = 0;
let expandedStreetIds = new Set();
let showReviewGeometry = true;
let showReviewText = false;
let outputViewMode = 'original';
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
function normalizeGraph(data) {
  const next = data && typeof data === 'object' ? data : {};
  next.annotations = Array.isArray(next.annotations) ? next.annotations : [];
  next.crossings = Array.isArray(next.crossings) ? next.crossings : [];
  next.joinCandidates = Array.isArray(next.joinCandidates) ? next.joinCandidates : [];
  next.confirmedConnections = Array.isArray(next.confirmedConnections) ? next.confirmedConnections : [];
  next.warnings = Array.isArray(next.warnings) ? next.warnings : [];
  next.edges = Array.isArray(next.edges) ? next.edges : [];
  next.nodes = Array.isArray(next.nodes) ? next.nodes : [];
  next.symbolCatalog = Array.isArray(next.symbolCatalog) ? next.symbolCatalog : [];
  next.documentModel = next.documentModel && typeof next.documentModel === 'object' ? next.documentModel : null;
  next.edges.forEach(edge => { if (edge.visible === undefined) edge.visible = true; });
  return next;
}
function setJobAddress(jobId) {
  if (!jobId || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  url.searchParams.set('job', jobId);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
function clearJobAddress() {
  if (!window.history?.replaceState) return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('job')) return;
  url.searchParams.delete('job');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
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

function updateAnalyzeButton() {
  analyzeBtn.disabled = !selectedFile || !selectedBuildingId;
  const label = analyzeBtn.querySelector('span:nth-child(2)');
  if (!label) return;
  if (!selectedBuildingId) label.textContent = 'Сначала выбери дом слева';
  else if (!selectedFile) label.textContent = 'Выбери фото схемы';
  else label.textContent = 'Отправить фото в выбранный дом';
}

function libraryBuildingContext(streetId, buildingId) {
  const street = addressLibrary.streets.find(item => item.id === streetId);
  const building = street?.buildings?.find(item => item.id === buildingId);
  return street && building ? { street, building } : null;
}

function selectedAddressText() {
  const context = libraryBuildingContext(selectedStreetId, selectedBuildingId);
  if (!context) return 'Выбери улицу и дом в папках слева';
  return `${context.street.name} · дом ${context.building.name}`;
}

function renderLibrary() {
  const root = $('libraryTree');
  if (!root) return;
  const query = String($('librarySearch')?.value || '').trim().toLocaleLowerCase('ru');
  const rows = [];
  for (const street of addressLibrary.streets || []) {
    const streetMatches = Boolean(query) && street.name.toLocaleLowerCase('ru').includes(query);
    const visibleBuildings = (street.buildings || []).filter(building => {
      const address = `${street.name} дом ${building.name}`.toLocaleLowerCase('ru');
      return !query || streetMatches || query.split(/[,\s]+/).every(word => address.includes(word))
        || (building.schemes || []).some(item => `${item.title} ${item.jobId}`.toLocaleLowerCase('ru').includes(query));
    });
    if (query && !visibleBuildings.length && !streetMatches) continue;
    const expanded = expandedStreetIds.has(street.id) || Boolean(query);
    const schemeCount = (street.buildings || []).reduce((sum, building) => sum + (building.schemes || []).length, 0);
    rows.push(`<div class="tree-group">
      <button type="button" class="tree-row tree-street ${selectedStreetId === street.id ? 'is-selected' : ''}" data-street-id="${escapeHtml(street.id)}" aria-expanded="${expanded}">
        <span class="tree-caret">${expanded ? '▾' : '▸'}</span><span class="tree-folder" aria-hidden="true"></span><span class="tree-name">${escapeHtml(street.name)}</span><span class="tree-count">${schemeCount}</span>
      </button>
      <div class="tree-children" ${expanded ? '' : 'hidden'}>
        ${visibleBuildings.map(building => {
          const selected = selectedBuildingId === building.id;
          const buildingMatches = Boolean(query) && query.split(/[,\s]+/).every(word => `${street.name} дом ${building.name}`.toLocaleLowerCase('ru').includes(word));
          const schemeList = (building.schemes || []).filter(item => !query || streetMatches || buildingMatches || `${item.title} ${item.jobId}`.toLocaleLowerCase('ru').includes(query));
          const expandedBuilding = selected || Boolean(query);
          return `<div class="tree-building-group">
            <button type="button" class="tree-row tree-building ${selected ? 'is-selected' : ''}" data-building-id="${escapeHtml(building.id)}" data-parent-street="${escapeHtml(street.id)}" aria-expanded="${expandedBuilding}">
              <span class="tree-caret">${expandedBuilding ? '▾' : '▸'}</span><span class="tree-house" aria-hidden="true">⌂</span><span class="tree-name">Дом ${escapeHtml(building.name)}</span><span class="tree-count">${(building.schemes || []).length}</span>
            </button>
            <div class="tree-schemes" ${expandedBuilding ? '' : 'hidden'}><div class="tree-inbox-label">ВХОДЯЩИЕ СХЕМЫ</div>
              ${schemeList.length ? schemeList.map(item => {
                const status = ['pending', 'processing', 'completed', 'failed'].includes(item.status) ? item.status : 'completed';
                const statusText = ({ pending: 'ВХОДЯЩАЯ', processing: 'В РАБОТЕ', completed: 'ГОТОВО', failed: 'ОШИБКА' })[status];
                return `<button type="button" class="tree-row tree-scheme ${selectedJobId === item.jobId ? 'is-current' : ''}" data-open-job="${escapeHtml(item.jobId)}" title="Открыть входящий эскиз"><span class="tree-file" aria-hidden="true"></span><span class="tree-name">${escapeHtml(item.title)}</span><span class="scheme-status ${status}">${statusText}</span></button>`;
              }).join('') : '<div class="tree-empty-scheme">Нет входящих эскизов</div>'}
            </div>
          </div>`;
        }).join('')}
        ${(street.buildings || []).length === 0 ? '<div class="tree-empty-scheme">Добавь дом в эту улицу</div>' : ''}
      </div>
    </div>`);
  }
  root.innerHTML = rows.join('') || `<div class="library-empty"><span class="empty-folder">▱</span><b>${addressLibrary.streets?.length ? 'Ничего не найдено' : 'Папки пока пусты'}</b><span>${addressLibrary.streets?.length ? 'Измени запрос поиска.' : 'Создай улицу, затем добавь дом.'}</span></div>`;
  root.querySelectorAll('[data-street-id]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.streetId;
    if (expandedStreetIds.has(id)) expandedStreetIds.delete(id); else expandedStreetIds.add(id);
    selectedStreetId = id;
    selectedBuildingId = null;
    renderLibrary(); updateLibrarySelection();
    showAddressInbox(id, null);
  }));
  root.querySelectorAll('[data-building-id]').forEach(button => button.addEventListener('click', () => {
    selectedStreetId = button.dataset.parentStreet;
    selectedBuildingId = button.dataset.buildingId;
    expandedStreetIds.add(selectedStreetId);
    renderLibrary(); updateLibrarySelection();
    showAddressInbox(selectedStreetId, selectedBuildingId);
  }));
  root.querySelectorAll('[data-open-job]').forEach(button => button.addEventListener('click', () => {
    const jobId = button.dataset.openJob;
    if (workspacePath === '/archive') window.location.assign(`/?job=${encodeURIComponent(jobId)}`);
    else void openLibraryScheme(jobId);
  }));
  const addBuilding = $('addBuildingBtn');
  if (addBuilding) addBuilding.disabled = !selectedStreetId;
}

function formatLibraryDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(date);
}

function updateLibrarySelection() {
  $('selectedLocation').textContent = selectedAddressText();
  $('selectedLocation').classList.toggle('has-address', Boolean(selectedBuildingId));
  updateAnalyzeButton();
}

function showAddressInbox(streetId, buildingId = null) {
  const street = addressLibrary.streets.find(item => item.id === streetId);
  const building = buildingId ? street?.buildings?.find(item => item.id === buildingId) : null;
  if (!street) return;
  clearJobAddress();
  schemePollToken += 1;
  activeScheme = null;
  graph = null;
  selectedJobId = null;
  clearJobAddress();
  setPanelsVisible(false);
  $('sourceImage').removeAttribute('src');
  $('overlay').innerHTML = '';
  $('imageFrame').hidden = true;
  $('sourceEmpty').hidden = false;
  $('cleanStage').classList.remove('manual-cad-preview');
  $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><b>Выбери входящую схему</b><span>После отправки фото автоматически ставится в очередь преобразования. Специалист проверяет результат и при необходимости исправляет его в CAD-редакторе.</span></div>';
  $('diagnosticLinks').hidden = true;
  $('processSchemeBtn').hidden = true;
  $('processSchemeBtn').disabled = false;
  $('mainTitle').textContent = building ? `Дом ${building.name}` : street.name;
  $('activeSchemeStatus').textContent = building ? 'ВХОДЯЩИЕ СХЕМЫ' : 'УЛИЦА';
  const count = building ? (building.schemes || []).length : (street.buildings || []).reduce((sum, item) => sum + (item.schemes || []).length, 0);
  $('activeSchemeMeta').textContent = building
    ? `${street.name} · ${count} ${count === 1 ? 'схема' : count >= 2 && count <= 4 ? 'схемы' : 'схем'} · новые фото автоматически поступают в очередь преобразования`
    : `Выбери дом, чтобы открыть его входящие схемы. Всего схем по улице: ${count}.`;
  $('canvasMeta').textContent = building ? 'Ожидает выбора входящей схемы' : 'Выбран адрес улицы';
  $('previewMeta').textContent = 'Ожидает изображения';
  setState(building ? 'ВХОДЯЩИЕ ДОМА' : 'ВЫБРАНА УЛИЦА');
}

async function loadAddressLibrary() {
  try {
    const response = await fetch('/api/library', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось загрузить папки объектов.');
    addressLibrary = data.library || { streets: [] };
    renderLibrary();
    updateLibrarySelection();
  } catch (error) {
    $('libraryTree').innerHTML = `<div class="library-error">${escapeHtml(error.message)}</div>`;
  }
}

let libraryDialogMode = 'street';
function openLibraryDialog(mode) {
  libraryDialogMode = mode;
  const isStreet = mode === 'street';
  $('libraryDialogTitle').textContent = isStreet ? 'Новая улица' : 'Новый дом';
  $('libraryDialogLabel').textContent = isStreet ? 'Название улицы' : 'Номер дома';
  $('libraryNameInput').placeholder = isStreet ? 'Например, Ленина' : 'Например, 12';
  $('libraryNameInput').value = '';
  $('libraryDialogError').textContent = '';
  $('libraryDialogError').hidden = true;
  $('libraryDialogHint').textContent = isStreet ? 'Улицы будут общими для всех специалистов.' : `Дом будет добавлен в папку «${libraryBuildingContext(selectedStreetId, selectedBuildingId)?.street.name || addressLibrary.streets.find(item => item.id === selectedStreetId)?.name || ''}».`;
  $('libraryDialog').showModal();
  $('libraryNameInput').focus();
}

$('addStreetBtn').addEventListener('click', () => openLibraryDialog('street'));
$('addBuildingBtn').addEventListener('click', () => openLibraryDialog('building'));
$('cancelLibraryDialog').addEventListener('click', () => $('libraryDialog').close());
$('librarySearch').addEventListener('input', renderLibrary);
$('librarySearchForm').addEventListener('submit', event => {
  event.preventDefault();
  $('object-library').scrollIntoView({ block: 'nearest' });
});

const workspacePath = window.location.pathname.replace(/\/$/, '') || '/';
const workspaceViews = {
  '/archive': { title: 'Архив', description: 'Найдите сохранённую схему по адресу или названию и откройте её для просмотра.' },
  '/settings': { title: 'Настройки', description: 'Управляйте эталоном чертежа и проверяйте доступность сервисов распознавания.' },
};
const workspaceView = workspaceViews[workspacePath];
if (workspaceView) {
  document.body.dataset.view = workspacePath.slice(1);
  document.title = `${workspaceView.title} · ПРОФИТ`;
  $('workspaceTitle').textContent = workspaceView.title;
  $('workspaceBreadcrumb').textContent = `Рабочий стол / ${workspaceView.title}`;
  $('workspaceDescription').textContent = workspaceView.description;
  document.querySelector('.profit-links [aria-current]')?.removeAttribute('aria-current');
  document.querySelector(`.profit-links a[href="${workspacePath}"]`)?.setAttribute('aria-current', 'page');
}
if (workspacePath === '/archive') {
  $('librarySearch').value = new URLSearchParams(window.location.search).get('q') || '';
}
if (workspacePath === '/settings') {
  $('templateSettings').open = true;
}
$('libraryDialogForm').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('libraryNameInput').value.trim();
  if (!name) return;
  const button = $('saveLibraryDialog');
  button.disabled = true;
  try {
    const endpoint = libraryDialogMode === 'street' ? '/api/library/streets' : '/api/library/buildings';
    const payload = libraryDialogMode === 'street' ? { name } : { name, streetId: selectedStreetId };
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось сохранить папку.');
    $('libraryDialog').close();
    if (libraryDialogMode === 'street') {
      selectedStreetId = data.street.id;
      selectedBuildingId = null;
      expandedStreetIds.add(selectedStreetId);
    } else {
      selectedBuildingId = data.building.id;
      expandedStreetIds.add(selectedStreetId);
    }
    await loadAddressLibrary();
    renderLibrary(); updateLibrarySelection();
  } catch (error) {
    $('libraryDialogError').textContent = error.message;
    $('libraryDialogError').hidden = false;
  } finally {
    button.disabled = false;
  }
});

function setPanelsVisible(visible) {
  for (const id of ['statsPanel', 'edgePanel', 'nodePanel', 'textPanel']) $(id).hidden = !visible;
  for (const id of ['exportSvg', 'exportDxf', 'exportJson', 'exportPdf']) $(id).disabled = !visible;
  $('openManualCadBtn').hidden = !visible;
}

function schemeStatusText(status) {
  return ({ pending: 'ВХОДЯЩИЙ ЭСКИЗ', queued: 'В ОЧЕРЕДИ НА ПРЕОБРАЗОВАНИЕ', processing: 'ИДЁТ ПРЕОБРАЗОВАНИЕ', completed: 'ПРЕОБРАЗОВАНО', failed: 'НЕ УДАЛОСЬ ОБРАБОТАТЬ' })[status] || 'ЭСКИЗ';
}

function showPendingScheme(scheme) {
  activeScheme = scheme;
  graph = null;
  selectedJobId = scheme.jobId;
  setJobAddress(scheme.jobId);
  setPanelsVisible(false);
  $('sourceEmpty').hidden = true;
  $('imageFrame').hidden = false;
  $('overlay').innerHTML = '';
  $('sourceImage').onload = () => fitImageFrame();
  $('sourceImage').onerror = () => setAlert('Не удалось открыть исходную фотографию.');
  $('sourceImage').src = `${scheme.sourceUrl}?v=${Date.now()}`;
  $('canvasMeta').textContent = `${scheme.originalName || scheme.title || 'Исходный эскиз'} · оригинал`;
  $('cleanStage').classList.remove('manual-cad-preview');
  $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><b>Вектор ещё не построен</b><span>Фотография автоматически поставлена в очередь. После обработки результат можно исправить в CAD-редакторе.</span></div>';
  $('diagnosticLinks').hidden = true;
  const manualButton = $('openManualCadBtn');
  manualButton.hidden = false;
  manualButton.disabled = false;
  manualButton.dataset.projectId = '';
  manualButton.innerHTML = '<b>CAD</b><span>Начертить вручную</span>';
  manualButton.title = 'Открыть редактор по исходной фотографии даже если автоматическое распознавание не завершилось';
  $('mainTitle').textContent = scheme.title || scheme.originalName || 'Входящий эскиз';
  $('activeSchemeStatus').textContent = schemeStatusText(scheme.status);
  $('activeSchemeMeta').textContent = `${scheme.streetName || ''}${scheme.streetName ? ', ' : ''}дом ${scheme.buildingName || ''} · ${formatLibraryDate(scheme.createdAt)}${scheme.uploadedBy ? ` · отправил: ${scheme.uploadedBy}` : ''}`;
  const process = $('processSchemeBtn');
  process.hidden = ['queued', 'processing', 'completed'].includes(scheme.status);
  process.disabled = ['queued', 'processing'].includes(scheme.status);
  process.textContent = scheme.status === 'failed' ? 'Повторить преобразование →' : 'Преобразовать в чистовой чертёж →';
  $('previewMeta').textContent = scheme.status === 'queued' ? 'Фото в очереди. Обработка начнётся автоматически после завершения предыдущей схемы.' : scheme.status === 'processing' ? 'Преобразование выполняется автоматически' : scheme.status === 'failed' ? 'Преобразование не завершено. При повторе сохранённые участки будут использованы, а недостающие — обработаны заново.' : 'Фото сохранено в папке дома';
  $('filePreview').hidden = true;
  $('progressWrap').hidden = scheme.status !== 'processing';
  setState(schemeStatusText(scheme.status), scheme.status === 'failed' ? 'error' : scheme.status === 'processing' ? 'busy' : 'ready');
}

async function openLibraryScheme(jobId) {
  schemePollToken += 1;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    setAlert('У схемы некорректный ID.'); return;
  }
  setAlert('');
  try {
    const response = await fetch(`/api/library/schemes/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось открыть эскиз.');
    const scheme = data.scheme;
    const address = (addressLibrary.streets || []).map(street => ({ street, building: (street.buildings || []).find(building => (building.schemes || []).some(item => item.jobId === jobId)) })).find(item => item.building);
    if (address) {
      selectedStreetId = address.street.id;
      selectedBuildingId = address.building.id;
      expandedStreetIds.add(selectedStreetId);
    }
    selectedFile = null;
    fileInput.value = '';
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    $('filePreview').hidden = true;
    $('fileName').textContent = 'Добавить фото схемы';
    updateLibrarySelection();
    renderLibrary();
    if (scheme.status === 'completed' || scheme.status === 'failed') {
      const statusResponse = await fetch(`/api/library/schemes/${encodeURIComponent(jobId)}/status`, { cache: 'no-store' });
      const statusData = await statusResponse.json().catch(() => ({}));
      if (statusData.graphReady) {
        await openSavedJob(jobId);
        return;
      }
    }
    showPendingScheme(scheme);
    if (['queued', 'processing'].includes(scheme.status)) pollSchemeStatus(jobId);
  } catch (error) {
    setAlert(error.message);
    setState('ОШИБКА ОТКРЫТИЯ', 'error');
  }
}

async function openSavedJob(jobId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    setAlert('У схемы некорректный ID.'); return;
  }
  setAlert(''); setState('ОТКРЫВАЮ СХЕМУ', 'busy');
  try {
    await loadAddressLibrary();
    const savedAddress = (addressLibrary.streets || []).map(street => ({ street, building: (street.buildings || []).find(building => (building.schemes || []).some(item => item.jobId === jobId)) })).find(item => item.building);
    const savedScheme = savedAddress?.building?.schemes?.find(item => item.jobId === jobId) || null;
    if (savedAddress) {
      selectedStreetId = savedAddress.street.id;
      selectedBuildingId = savedAddress.building.id;
      expandedStreetIds.add(selectedStreetId);
    }
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/graph`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    graph = normalizeGraph(data);
    const partialResult = graph.complete === false || graph.analysisStatus === 'incomplete';
    activeScheme = savedScheme
      ? { ...savedScheme, status: partialResult ? 'failed' : 'completed', streetName: savedAddress.street.name, buildingName: savedAddress.building.name }
      : { jobId, title: partialResult ? 'Частично обработанная схема' : 'Обработанная схема', status: partialResult ? 'failed' : 'completed' };
    selectedJobId = jobId;
    activeJoinId = null; activeJoinGroupNode = null; showAllSegments = false;
    connectMode = false; firstNode = null;
    selectedFile = null; fileInput.value = '';
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    $('filePreview').hidden = true; $('fileName').textContent = 'Добавить фото схемы';
    updateAnalyzeButton();
    setJobAddress(jobId);
    $('mainTitle').textContent = activeScheme.title || 'Векторная схема';
    $('activeSchemeMeta').textContent = `${activeScheme.streetName || ''}${activeScheme.streetName ? ', ' : ''}дом ${activeScheme.buildingName || ''} · ${formatLibraryDate(activeScheme.completedAt || activeScheme.createdAt)}`;
    showResult();
    if (partialResult) {
      $('processSchemeBtn').hidden = false;
      $('processSchemeBtn').disabled = false;
      $('processSchemeBtn').textContent = 'Повторить недостающие участки →';
      $('activeSchemeStatus').textContent = 'ЧАСТИЧНЫЙ РЕЗУЛЬТАТ · REVIEW';
      $('previewMeta').textContent = 'Показана неполная схема для проверки. Недостающие плитки можно обработать повторно.';
      setAlert('Это промежуточный результат: не все плитки Qwen обработаны. Не используй его как окончательный чертёж. Нажми «Повторить недостающие участки», чтобы продолжить с сохранённых checkpoint-файлов.');
      setState('НЕПОЛНЫЙ ЧЕРТЁЖ · ТРЕБУЕТСЯ ПРОВЕРКА', 'error');
    } else {
      $('processSchemeBtn').hidden = true;
      $('activeSchemeStatus').textContent = 'ПРЕОБРАЗОВАНО · ПРОВЕРИТЬ';
      $('previewMeta').textContent = 'Сохранённая схема открыта из папки дома';
      setState('СХЕМА ОТКРЫТА');
    }
    updateLibrarySelection();
    renderLibrary();
    await ensureHouseSchemeCadProject(jobId);
  } catch (error) {
    setAlert(`Не удалось открыть схему: ${error.message}`); setState('ОШИБКА ОТКРЫТИЯ', 'error');
  }
}

function renderHouseSchemeCadPreview(project) {
  if (!graph || !project?.id) return;
  graph.manualCadProjectId = project.id;
  graph.manualCadPreviewUrl = project.previewUrl || `/api/manual-cad/projects/${encodeURIComponent(project.id)}/preview.svg`;
  graph.manualCadEditUrl = project.editUrl || `/manual-cad.html?project=${encodeURIComponent(project.id)}`;
  const button = $('openManualCadBtn');
  button.hidden = false;
  button.disabled = false;
  button.dataset.projectId = project.id;
  button.innerHTML = '<b>CAD</b><span>Редактировать</span>';
  button.title = 'Открыть этот чертёж в ручном CAD; изменения сохраняются в проекте дома';
  const previewUrl = `${graph.manualCadPreviewUrl}${graph.manualCadPreviewUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(project.updatedAt || Date.now())}`;
  const pipes = Array.isArray(project.pipes) ? project.pipes : [];
  const pipeCount = pipes.filter(pipe => pipe.reviewOnly !== true).length;
  const reviewCount = pipes.filter(pipe => pipe.reviewOnly === true).length;
  const completeness = pipeCount === 0 && reviewCount === 0 ? 'АВТОЧЕРНОВИК НЕ СОДЕРЖИТ ТРАСС · ПРОВЕРЬ ИСХОДНИК' : 'АВТОМАТИЧЕСКИЙ РЕДАКТИРУЕМЫЙ ЧЕРНОВИК · ПРОВЕРИТЬ В РЕДАКТОРЕ';
  $('cleanStage').classList.add('manual-cad-preview');
  $('cleanStage').innerHTML = `<img class="manual-cad-preview-image" src="${escapeHtml(previewUrl)}" alt="Автоматический редактируемый CAD-черновик LPGCad R1 для ${escapeHtml(project.title || 'схемы дома')}" loading="eager"><div class="manual-cad-preview-caption"><b>${escapeHtml(completeness)}</b><span>${escapeHtml(project.siteAddress || activeScheme?.streetName || 'Адрес из папки дома')} · ${pipeCount} основных маршрутов · ${reviewCount} непроверенных кандидатов · ${Number(project.symbols?.length || 0)} символов · ${Number(project.labels?.length || 0)} подписей. Непроверенные участки можно подсветить в CAD-редакторе.</span></div>`;
  $('cleanStage').querySelector('img')?.addEventListener('error', () => {
    $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><b>Не удалось показать чистовой лист</b><span>Проект CAD сохранён. Открой его кнопкой «Редактировать».</span></div>';
  }, { once: true });
  $('previewMeta').textContent = pipeCount === 0 && reviewCount === 0
    ? 'Автоматический черновик создан, но трубные маршруты не выделены. Открой редактор: исходник и объекты распознавания сохранены.'
    : 'Автоматический черновик показан сразу. Чёрные линии — основной отбор, оранжевые пунктирные — кандидаты. Открой редактор, чтобы перемещать и редактировать трубы, узлы, символы и подписи; экспорт чистового листа делай после проверки.';
}

async function ensureHouseSchemeCadProject(jobId) {
  if (!graph || graph.jobId !== jobId) return null;
  const button = $('openManualCadBtn');
  button.hidden = false;
  button.disabled = true;
  button.innerHTML = '<b>CAD</b><span>Подготовка…</span>';
  try {
    const response = await fetch(`/api/manual-cad/import-job/${encodeURIComponent(jobId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: activeScheme?.title || 'Схема дома' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderHouseSchemeCadPreview(data.project);
    if (data.preservedManualEdits) {
      $('previewMeta').textContent += ' Сохранённая ручная редакция не была перезаписана повторным распознаванием.';
    }
    return data.project;
  } catch (error) {
    button.disabled = false;
    button.innerHTML = '<b>CAD</b><span>Открыть редактор</span>';
    button.title = error.message;
    $('previewMeta').textContent = `Не удалось подготовить чистовой CAD-лист: ${error.message}`;
    console.warn('House scheme CAD project preparation failed:', error);
    return null;
  }
}

async function pollSchemeStatus(jobId) {
  const token = ++schemePollToken;
  const processButton = $('processSchemeBtn');
  processButton.disabled = true;
  $('progressWrap').hidden = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  while (token === schemePollToken && activeScheme?.jobId === jobId) {
    await delay(2500);
    if (token !== schemePollToken || activeScheme?.jobId !== jobId) return;
    try {
      const response = await fetch(`/api/library/schemes/${encodeURIComponent(jobId)}/status`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Не удалось проверить статус.');
      activeScheme.status = data.status;
      $('progressLabel').textContent = data.progress ? data.progress.replace(/^.*?\] /, '') : data.status === 'queued' ? `В очереди на GTX 1060${data.queuePosition ? ` · позиция ${data.queuePosition}` : ''}…` : 'Подготовка обработки…';
      $('activeSchemeStatus').textContent = schemeStatusText(data.status);
      $('previewMeta').textContent = schemeStatusText(data.status);
      if (data.status === 'completed' && data.graphReady) {
        $('progressWrap').hidden = true;
        await openSavedJob(jobId);
        return;
      }
      if (data.status === 'failed') {
        $('progressWrap').hidden = true;
        await loadAddressLibrary();
        if (data.graphReady) {
          await openSavedJob(jobId);
          $('processSchemeBtn').hidden = false;
          $('processSchemeBtn').disabled = false;
          $('processSchemeBtn').textContent = 'Повторить недостающие участки →';
          if (data.error) setAlert(`${data.error} Показанный результат неполный и предназначен только для проверки.`);
          setState('НЕПОЛНЫЙ ЧЕРТЁЖ · ТРЕБУЕТСЯ ПРОВЕРКА', 'error');
        } else {
          processButton.disabled = false;
          processButton.hidden = false;
          processButton.textContent = 'Повторить преобразование →';
          setAlert(data.error || 'Не удалось преобразовать эскиз. Повтори запуск: ранее сохранённые участки будут восстановлены, если они есть.');
          setState('ОШИБКА ПРЕОБРАЗОВАНИЯ', 'error');
        }
        return;
      }
    } catch (error) {
      $('progressLabel').textContent = error.message;
    }
  }
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
  clearJobAddress();
  activeScheme = null;
  $('processSchemeBtn').hidden = true;
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
  selectedJobId = null;
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
  updateAnalyzeButton();
  graph = null;
  $('statsPanel').hidden = true;
  $('edgePanel').hidden = true;
  $('nodePanel').hidden = true;
  $('textPanel').hidden = true;
  $('openManualCadBtn').hidden = true;
  $('sourceEmpty').hidden = false;
  $('imageFrame').hidden = true;
  $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><b>Фото готово к отправке</b><span>Сначала выбери адрес слева и отправь эскиз в папку дома.</span></div>';
  $('canvasMeta').textContent = `${file.name} · ${formatBytes(file.size)}`;
  $('previewMeta').textContent = `${formatBytes(file.size)} · готов к обработке`;
  setState('ФОТО ГОТОВО К ОТПРАВКЕ');
}

$('clearFile').addEventListener('click', () => {
  clearJobAddress();
  activeScheme = null;
  $('processSchemeBtn').hidden = true;
  selectedFile = null;
  selectedJobId = null;
  graph = null;
  fileInput.value = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('filePreview').hidden = true;
  $('fileName').textContent = 'Перетащи фото сюда';
  updateAnalyzeButton();
  $('sourceEmpty').hidden = false;
  $('imageFrame').hidden = true;
  $('statsPanel').hidden = true;
  $('edgePanel').hidden = true;
  $('nodePanel').hidden = true;
  $('textPanel').hidden = true;
  $('openManualCadBtn').hidden = true;
  $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><div class="empty-art blue"><span>CAD</span></div><b>Векторный лист пока пуст</b><span>После анализа здесь появится предварительная CAD-схема.</span></div>';
  $('canvasMeta').textContent = 'Ожидает изображения';
  setAlert('');
  setState('ГОТОВ К РАБОТЕ');
});

analyzeBtn.addEventListener('click', async () => {
  if (!selectedFile || !selectedStreetId || !selectedBuildingId || analyzeBtn.disabled) return;
  setAlert('');
  analyzeBtn.disabled = true;
  $('progressWrap').hidden = false;
  $('progressLabel').textContent = 'Отправляю фотографию в папку выбранного дома…';
  $('progressPercent').textContent = 'ОТПРАВКА';
  analyzeBtn.querySelector('span:nth-child(2)').textContent = 'Отправляю…';
  setState('ОТПРАВКА В АРХИВ', 'busy');
  try {
    const form = new FormData();
    form.append('image', selectedFile, selectedFile.name);
    form.append('streetId', selectedStreetId);
    form.append('buildingId', selectedBuildingId);
    form.append('title', selectedFile.name.replace(/\.[^.]+$/, ''));
    const requestedRotation = $('sketchRotation')?.value || 'auto';
    if (['0','90','180','270'].includes(requestedRotation)) form.append('rotationDegrees', requestedRotation);
    const response = await fetch('/api/library/schemes/upload', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Ошибка сервера ${response.status}`);
    const jobId = data.scheme?.jobId;
    if (!jobId) throw new Error('Сервер сохранил файл, но не вернул номер схемы.');
    selectedFile = null;
    selectedJobId = null;
    fileInput.value = '';
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    $('filePreview').hidden = true;
    $('fileName').textContent = 'Добавить фото схемы';
    await loadAddressLibrary();
    const savedAddress = (addressLibrary.streets || []).map(street => ({
      street, building: (street.buildings || []).find(building => (building.schemes || []).some(item => item.jobId === jobId))
    })).find(item => item.building);
    if (savedAddress) {
      selectedStreetId = savedAddress.street.id;
      selectedBuildingId = savedAddress.building.id;
      expandedStreetIds.add(selectedStreetId);
      renderLibrary();
      updateLibrarySelection();
    }
    activeScheme = {
      ...data.scheme,
      streetName: savedAddress?.street?.name || '',
      buildingName: savedAddress?.building?.name || ''
    };
    showPendingScheme(activeScheme);
    setAlert(activeScheme.status === 'queued'
      ? 'Фото отправлено. Оно автоматически поставлено в очередь преобразования.'
      : 'Фото отправлено. Автоматическое преобразование запущено.');
    if (['queued', 'processing'].includes(activeScheme.status)) pollSchemeStatus(jobId);
  } catch (error) {
    console.error('Upload failed', error);
    setAlert(`Не удалось отправить эскиз: ${error.message}`);
    setState('ОШИБКА ОТПРАВКИ', 'error');
  } finally {
    $('progressWrap').hidden = true;
    analyzeBtn.disabled = false;
    updateAnalyzeButton();
  }
});

$('processSchemeBtn').addEventListener('click', async () => {
  if (!activeScheme?.jobId || $('processSchemeBtn').disabled) return;
  const jobId = activeScheme.jobId;
  setAlert('');
  $('processSchemeBtn').disabled = true;
  $('processSchemeBtn').textContent = 'Запуск…';
  $('progressWrap').hidden = false;
  $('progressLabel').textContent = 'Ставлю схему в очередь обработки…';
  $('progressPercent').textContent = 'В РАБОТЕ';
  setState('ЗАПУСК ПРЕОБРАЗОВАНИЯ', 'busy');
  try {
    const response = await fetch(`/api/library/schemes/${encodeURIComponent(jobId)}/analyze`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Ошибка сервера ${response.status}`);
    activeScheme.status = data.status || 'processing';
    $('processSchemeBtn').hidden = true;
    $('activeSchemeStatus').textContent = schemeStatusText(activeScheme.status);
    setState('ПРЕОБРАЗОВАНИЕ ВЫПОЛНЯЕТСЯ', 'busy');
    pollSchemeStatus(jobId);
    loadAddressLibrary();
  } catch (error) {
    $('processSchemeBtn').disabled = false;
    $('processSchemeBtn').textContent = 'Повторить преобразование →';
    $('progressWrap').hidden = true;
    setAlert(error.message);
    setState('ОШИБКА ЗАПУСКА', 'error');
  }
});

function assessCadReadiness(data) {
  const summary = data?.summary || {};
  const model = data?.documentModel || {};
  const segments = Number(summary.segment_candidates ?? 0);
  const primaryEdges = Number(summary.cad_primary_edges ?? (Array.isArray(model.pipes) ? model.pipes.filter(item => item?.state === 'primary').length : 0));
  const openEndpoints = Number(summary.open_terminal_nodes ?? 0);
  const crossings = Number(summary.crossings_to_review ?? data?.crossings?.length ?? 0);
  const symbols = Array.isArray(model.symbols) ? model.symbols : [];
  const dimensions = Array.isArray(model.dimensions) ? model.dimensions : [];
  const classifiedSymbols = symbols.filter(item => Boolean(item?.type)).length;
  const assignedDimensions = dimensions.filter(item => Boolean(item?.targetId)).length;
  const reasons = [];
  if (primaryEdges <= 0) reasons.push('не выделены основные трубные маршруты');
  if (segments >= 20 && openEndpoints / segments > 0.70) {
    reasons.push(`слишком много открытых концов (${openEndpoints}/${segments})`);
  }
  if (segments >= 20 && crossings / segments > 0.12) {
    reasons.push(`слишком много неоднозначных пересечений (${crossings}/${segments})`);
  }
  if (symbols.length > 0 && classifiedSymbols / symbols.length < 0.50) {
    reasons.push(`не классифицировано оборудование (${classifiedSymbols}/${symbols.length})`);
  }
  if (dimensions.length > 0 && assignedDimensions / dimensions.length < 0.50) {
    reasons.push(`размеры не привязаны к объектам (${assignedDimensions}/${dimensions.length})`);
  }
  if (data?.analysisStatus === 'incomplete' || data?.complete === false) {
    reasons.push('не завершены все этапы обработки');
  }
  return {
    ready: reasons.length === 0,
    reasons,
    metrics: { primaryEdges, segments, openEndpoints, crossings, symbols: symbols.length,
      classifiedSymbols, dimensions: dimensions.length, assignedDimensions }
  };
}

function syncOutputExportButtons() {
  if (!graph) return;
  const hasReferenceTrace = Boolean(graph.referenceTrace?.available && graph.referenceTraceSvgUrl);
  const hasCenterlineTrace = Boolean(graph.centerlineTrace?.available && graph.centerlineTraceSvgUrl);
  const processingComplete = graph.complete !== false && graph.analysisStatus !== 'incomplete';
  const cadReady = assessCadReadiness(graph).ready;
  const sourceOnly = outputViewMode === 'original';
  const cadDraftBlocked = outputViewMode === 'cad' && !cadReady;
  $('exportSvg').disabled = sourceOnly || cadDraftBlocked || !(hasCenterlineTrace || hasReferenceTrace || processingComplete);
  $('exportDxf').disabled = sourceOnly || cadDraftBlocked || !(hasCenterlineTrace || hasReferenceTrace || processingComplete);
  $('exportPdf').disabled = outputViewMode === 'original'
    ? !graph.sourceUrl
    : cadDraftBlocked || !(hasCenterlineTrace || hasReferenceTrace || processingComplete);
  $('exportJson').disabled = false;
}

function showResult() {
  const processingComplete = graph.complete !== false && graph.analysisStatus !== 'incomplete';
  const cadReadiness = assessCadReadiness(graph);
  $('openManualCadBtn').hidden = !graph.jobId;
  $('openManualCadBtn').disabled = false;
  $('openManualCadBtn').innerHTML = '<b>CAD</b><span>Редактировать схему</span>';
  $('openManualCadBtn').title = 'Открыть автоматически собранный CAD-черновик. Все основные и непроверенные объекты доступны для редактирования.';
  $('processSchemeBtn').hidden = processingComplete;
  $('processSchemeBtn').disabled = false;
  $('processSchemeBtn').textContent = processingComplete ? 'Преобразовано' : 'Продолжить обработку →';
  $('activeSchemeStatus').textContent = processingComplete ? 'ОБРАБОТКА ЗАВЕРШЕНА · ПРОВЕРИТЬ' : 'ЧАСТИЧНЫЙ РЕЗУЛЬТАТ · НУЖНО ПРОДОЛЖИТЬ';
  $('statsPanel').hidden = false;
  $('edgePanel').hidden = false;
  $('nodePanel').hidden = false;
  $('textPanel').hidden = false;
  $('reviewPanel').hidden = !graph.documentModel;
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
      graph.cadAlignmentOverlayUrl ? `<a href="${escapeHtml(graph.cadAlignmentOverlayUrl)}" target="_blank" rel="noreferrer">Наложение CAD на исходное фото</a>` : '',
      graph.textMaskUrl ? `<a href="${escapeHtml(graph.textMaskUrl)}" target="_blank" rel="noreferrer">Маска OCR-областей</a>` : '',
      graph.geometryInkUrl ? `<a href="${escapeHtml(graph.geometryInkUrl)}" target="_blank" rel="noreferrer">Чернила без текста</a>` : '',
      graph.handwrittenTextBlocksUrl ? `<a href="${escapeHtml(graph.handwrittenTextBlocksUrl)}" target="_blank" rel="noreferrer">Текстовые блоки OCR</a>` : '',
      graph.centerlineTraceSvgUrl && graph.centerlineTrace?.available ? `<a href="${escapeHtml(graph.centerlineTraceSvgUrl)}" target="_blank" rel="noreferrer">Линейная векторизация SVG</a>` : '',
      graph.centerlineTraceDxfUrl && graph.centerlineTrace?.available ? `<a href="${escapeHtml(graph.centerlineTraceDxfUrl)}" target="_blank" rel="noreferrer">Линейная векторизация DXF</a>` : '',
      graph.referenceTraceSvgUrl && graph.referenceTrace?.available ? `<a href="${escapeHtml(graph.referenceTraceSvgUrl)}" target="_blank" rel="noreferrer">Контуры оригинала SVG</a>` : '',
      graph.referenceTraceDxfUrl && graph.referenceTrace?.available ? `<a href="${escapeHtml(graph.referenceTraceDxfUrl)}" target="_blank" rel="noreferrer">Контуры DXF</a>` : '',
      graph.cadDraftSvgUrl ? `<a href="${escapeHtml(graph.cadDraftSvgUrl)}" target="_blank" rel="noreferrer">CAD-черновик SVG</a>` : '',
      graph.cadDraftDxfUrl ? `<a href="${escapeHtml(graph.cadDraftDxfUrl)}" target="_blank" rel="noreferrer">CAD-черновик DXF</a>` : '',
      graph.progressUrl ? `<a href="${escapeHtml(graph.progressUrl)}" target="_blank" rel="noreferrer">Журнал обработки</a>` : '',
      graph.diagnosticsUrl ? `<a href="${escapeHtml(graph.diagnosticsUrl)}" target="_blank" rel="noreferrer">Диагностика JSON</a>` : ''
    ].filter(Boolean);
    diagnostics.innerHTML = links.join('<span>·</span>');
    diagnostics.hidden = !links.length;
  }
  const hasReferenceTrace = Boolean(graph.referenceTrace?.available && graph.referenceTraceSvgUrl);
  const hasCenterlineTrace = Boolean(graph.centerlineTrace?.available && graph.centerlineTraceSvgUrl);
  $('previewMeta').textContent = !cadReadiness.ready
    ? `Автоматический черновик доступен для редактирования, но не прошёл контроль чистового экспорта: ${cadReadiness.reasons.join('; ')}.`
    : hasCenterlineTrace
      ? `${Number(graph.centerlineTrace.paths || 0).toLocaleString('ru-RU')} открытых линейных полилиний · исходные штрихи; не семантическая сеть труб.`
      : hasReferenceTrace
        ? `Векторная копия оригинала сохранена · ${Number(graph.referenceTrace.contours || 0).toLocaleString('ru-RU')} контуров. CAD-черновик требует инженерной проверки.`
        : (processingComplete ? 'CAD-черновик сформирован · инженерная проверка обязательна' : 'Распознавание неполное · CAD-черновик только для проверки');
  const trace = graph.semanticTrace || {};
  const summary = graph.summary || {};
  const qwenRouteCount = Number(summary.semantic_routes ?? graph.semanticRoutes?.length ?? 0);
  const primaryPathCount = Number(summary.cad_primary_total_paths ?? summary.cad_primary_chains ?? summary.cad_primary_paths ?? 0);
  const qwenPrimaryCount = Number(summary.cad_primary_qwen_routes ?? 0);
  const isolatedReview = Number(summary.isolated_strokes_kept_for_review || 0);
  const topologyNetworkComponents = Number(summary.topology_network_candidate_components || 0);
  const topologyNetworkEdges = Number(summary.topology_network_primary_edges || 0);
  const structuredRouteComponents = Number(summary.structured_route_components || 0);
  const textBlockCount = Number(summary.text_block_annotations || 0);
  const textReviewCount = Number(summary.text_review_annotations || 0);
  const traceState = `Геометрических CAD-кандидатов: ${primaryPathCount} (Qwen, подтверждённых чернилами: ${qwenPrimaryCount}); это не число инженерно проверенных трубопроводов. Остальные маршруты Qwen: ${qwenRouteCount - qwenPrimaryCount}. Структурных компонентов: ${structuredRouteComponents}; многоветвевых сетей: ${topologyNetworkComponents} (${topologyNetworkEdges} рёбер в PIPE_MAIN). Строк из рукописных блоков: ${textBlockCount}; текст на ручную проверку: ${textReviewCount}. Изолированных штрихов на проверке: ${isolatedReview}. `;
  $('statusline').textContent = traceState + graph.warnings.join(' ');
  const stats = [
    [summary.segment_candidates ?? graph.edges.length, 'отрезков-кандидатов'],
    [summary.nodes ?? graph.nodes.length, 'узлов графа'],
    [summary.edges ?? graph.edges.length, 'связей'],
    [summary.crossings_to_review ?? graph.crossings.length, 'пересечений на проверку'],
    [summary.ocr_annotations ?? graph.annotations.length, 'OCR-подписей'],
    [primaryPathCount, 'CAD-кандидатов трасс']
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
  renderReviewList();
  $('exportSvg').title = outputViewMode === 'centerline' ? 'Скачать все открытые линии исходных штрихов; содержит текст и символы' : outputViewMode === 'reference' ? 'Скачать контуры всех исходных штрихов' : 'Скачать CAD-черновик SVG';
  $('exportDxf').title = outputViewMode === 'centerline' ? 'Скачать все открытые линии исходных штрихов; не является трубной сетью' : outputViewMode === 'reference' ? 'Скачать векторные контуры исходных штрихов' : 'Скачать CAD-черновик DXF';
  if (!cadReadiness.ready) {
    setAlert(`Автоматический CAD-черновик сформирован и доступен в редакторе. Он пока не прошёл проверку чистового экспорта: ${cadReadiness.reasons.join('; ')}. Основные линии и кандидаты можно редактировать; перед техническим использованием требуется проверка инженером.`);
  } else if (!processingComplete) {
    setAlert('Обработка не завершена полностью. CAD-черновик доступен только для проверки.');
  } else {
    setAlert('CAD-черновик сформирован. Перед использованием в технической документации требуется инженерная проверка.');
  }
  setState(cadReadiness.ready && processingComplete
    ? 'CAD-ЧЕРНОВИК СФОРМИРОВАН · НУЖНА ПРОВЕРКА'
    : 'АВТОЧЕРНОВИК · ТРЕБУЕТСЯ РЕДАКТИРОВАНИЕ', cadReadiness.ready && processingComplete ? 'ready' : 'busy');
  // Show the generated editable CAD draft regardless of final-export readiness.
  // The quality gate still controls clean export buttons, not whether users can see/edit the draft.
  setOutputViewMode('cad');
  document.querySelectorAll('.flow-step').forEach((el, index) => el.classList.toggle('active', index < 3));
}

function fitImageFrame() {
  if ($('imageFrame').hidden) return;
  const stage = $('sourceStage');
  const imageWidth = graph?.image?.width || $('sourceImage').naturalWidth;
  const imageHeight = graph?.image?.height || $('sourceImage').naturalHeight;
  if (!imageWidth || !imageHeight) return;
  const ratio = imageWidth / imageHeight;
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
  const previewCandidates = activeJoinGroupNode
    ? graph.joinCandidates.filter(item => (item.conflicting_nodes || []).includes(activeJoinGroupNode))
    : (activeJoinId ? graph.joinCandidates.filter(item => item.id === activeJoinId) : []);
  const nodeById = new Map(graph.nodes.map(node => [String(node.id), node]));
  const joinPreview = previewCandidates.map((candidate, index) => {
    const a = nodeById.get(String(candidate.from));
    const b = nodeById.get(String(candidate.to));
    if (!a || !b) return '';
    const color = index === 0 ? '#159879' : '#e18a32';
    const midpointX = (Number(a.x) + Number(b.x)) / 2;
    const midpointY = (Number(a.y) + Number(b.y)) / 2;
    return `<g class="join-preview" pointer-events="none">
      <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".9"/>
      <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="3.5" stroke-dasharray="7 4" stroke-linecap="round"/>
      <circle cx="${a.x}" cy="${a.y}" r="7.5" fill="#fff" stroke="${color}" stroke-width="2.5"/>
      <circle cx="${b.x}" cy="${b.y}" r="7.5" fill="#fff" stroke="${color}" stroke-width="2.5"/>
      <rect x="${midpointX - 13}" y="${midpointY - 17}" width="26" height="15" rx="4" fill="${color}"/>
      <text x="${midpointX}" y="${midpointY - 6}" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">${escapeHtml(candidate.id)}</text>
    </g>`;
  }).join('');
  const overlay = $('overlay');
  overlay.setAttribute('viewBox', `0 0 ${graph.image.width} ${graph.image.height}`);
  overlay.setAttribute('preserveAspectRatio', 'none');
  overlay.innerHTML = lines + crossings + joinPreview + nodes;
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
$('showReviewGeometry').addEventListener('change', event => { showReviewGeometry = event.target.checked; renderClean(); });
$('showReviewText').addEventListener('change', event => { showReviewText = event.target.checked; renderClean(); });

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
function addManualConnectionLocal(from, to) {
  const a = graph.nodes.find(node => node.id === from);
  const b = graph.nodes.find(node => node.id === to);
  if (!a || !b || a.id === b.id) return false;
  const exists = graph.edges.some(edge => (edge.from === a.id && edge.to === b.id) || (edge.from === b.id && edge.to === a.id));
  if (exists) return false;
  const id = nextEdgeId();
  graph.edges.push({ id, from: a.id, to: b.id, source: 'manual', confidence: 1,
    geometry: [[a.x, a.y], [b.x, b.y]], visible: true, review: false, detector: 'MANUAL',
    component_role: 'line_structure', component_id: 'MANUAL', manual_reason: 'user-created-connection' });
  a.degree = (a.degree || 0) + 1;
  b.degree = (b.degree || 0) + 1;
  graph.confirmedConnections.push({ id: `MC${graph.confirmedConnections.length + 1}`, edgeId: id, from, to, confirmation: 'local-user-action' });
  $('edgeCount').textContent = graph.edges.length.toLocaleString('ru-RU');
  renderOverlay(); renderClean(); renderEdgeList(); renderNodeList(); renderJoinList();
  return true;
}

function refreshGraphAfterConnection(data, message) {
  graph = normalizeGraph(data);
  activeJoinId = null;
  activeJoinGroupNode = null;
  showResult();
  setState('СОЕДИНЕНИЕ СОХРАНЕНО');
  $('selectMode').textContent = message;
  $('previewMeta').textContent = `Сохранённое задание · подтверждённых соединений: ${graph.confirmedConnections.length}`;
}

async function persistManualConnection(from, to, { candidate = null } = {}) {
  if (!graph.jobId) {
    const ok = addManualConnectionLocal(from, to);
    if (!ok) throw new Error('Соединение не добавлено: узлы отсутствуют или связь уже существует.');
    return true;
  }
  const response = await fetch(`/api/jobs/${encodeURIComponent(graph.jobId)}/connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to,
      candidateId: candidate?.id || null,
      confirmAlternative: Boolean(candidate?.has_alternatives)
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.graph) throw new Error(data.error || `Ошибка сохранения соединения (${response.status})`);
  refreshGraphAfterConnection(data.graph, `Сохранено ${candidate?.id ? `${candidate.id}: ` : ''}${from} ↔ ${to}`);
  return true;
}

$('connectMode').addEventListener('click', () => {
  connectMode = !connectMode;
  firstNode = null;
  if (connectMode) $('showNodes').checked = true;
  $('connectHelp').hidden = !connectMode;
  $('connectHelp').textContent = 'Выбери первый узел, затем второй. Подтверждённое вручную соединение будет сохранено в задании.';
  $('connectMode').textContent = connectMode ? 'Отмена соединения' : '＋ Соединить два узла';
  $('selectMode').textContent = connectMode ? 'Режим: выбери два узла' : 'Режим: просмотр';
  renderOverlay();
});
async function chooseNode(id) {
  if (!firstNode) {
    firstNode = id;
    $('connectHelp').textContent = `Первый узел: ${id}. Теперь выбери второй узел.`;
    renderOverlay();
    return;
  }
  if (firstNode === id) return;
  const from = firstNode;
  connectMode = false;
  firstNode = null;
  $('connectHelp').hidden = true;
  $('connectMode').textContent = '＋ Соединить два узла';
  try {
    await persistManualConnection(from, id);
  } catch (error) {
    setAlert(`Не удалось сохранить соединение: ${error.message}`);
    setState('ОШИБКА СОХРАНЕНИЯ', 'error');
  }
  renderOverlay();
}

function collectJoinConflictGroups(joins) {
  const grouped = new Map();
  for (const join of joins) {
    for (const nodeId of (join.conflicting_nodes || [])) {
      if (!grouped.has(nodeId)) grouped.set(nodeId, []);
      grouped.get(nodeId).push(join);
    }
  }
  return [...grouped.entries()]
    .map(([nodeId, candidates]) => ({
      nodeId,
      candidates: [...new Map(candidates.map(item => [item.id, item])).values()]
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    }))
    .filter(group => group.candidates.length > 1)
    .sort((a, b) => b.candidates.length - a.candidates.length);
}

function scrollToJoinPreview() {
  $('sourceStage')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderJoinList() {
  const joins = Array.isArray(graph.joinCandidates) ? graph.joinCandidates.slice(0, 120) : [];
  const groups = collectJoinConflictGroups(joins);
  const groupHtml = groups.map(group => {
    const ranked = group.candidates;
    const gap = Math.abs(Number(ranked[0].score || 0) - Number(ranked[1].score || 0));
    const pairs = ranked.map(item => `${escapeHtml(item.id)}: ${escapeHtml(item.from)} ↔ ${escapeHtml(item.to)} (${Number(item.score || 0).toFixed(1)})`).join(' · ');
    return `<div class="join-conflict-group">
      <div><b>Конкурирующие пары у узла ${escapeHtml(group.nodeId)}</b><small>${pairs}</small><small>Разница оценок двух лучших вариантов: ${gap.toFixed(1)} балла. Это рейтинг, не вероятность.</small></div>
      <button type="button" data-compare-node="${escapeHtml(group.nodeId)}">Сравнить</button>
    </div>`;
  }).join('');
  const confirmed = Array.isArray(graph.confirmedConnections) ? graph.confirmedConnections : [];
  const confirmedHtml = confirmed.length ? `<div class="join-confirmed"><b>Сохранённые соединения (${confirmed.length})</b>${confirmed.slice(-8).map(item => `<small>${escapeHtml(item.candidateId || item.id)} · ${escapeHtml(item.from)} ↔ ${escapeHtml(item.to)} · ${escapeHtml(item.edgeId || '')}</small>`).join('')}</div>` : '';
  const joinsHtml = joins.map(join => {
    const high = join.priority === 'high' && !join.has_alternatives;
    const flags = Array.isArray(join.review_flags) ? join.review_flags : [];
    const details = [
      `${join.distance} px`,
      `соосность ${Math.round(Number(join.alignment || 0) * 100)}%`,
      `поперечное ${join.lateral_offset_px ?? '?'} px`
    ].join(' · ');
    const warning = join.has_alternatives ? `Есть альтернативные пары: ${(join.conflicting_nodes || []).join(', ')}` : (join.message || 'Требуется визуальная проверка');
    return `<div class="rowitem join-candidate ${high ? 'join-high' : 'join-review'} ${activeJoinId === join.id ? 'join-active' : ''}">
      <div class="join-candidate-main">
        <span class="id">${escapeHtml(join.id)}</span>
        <span class="meta">${escapeHtml(join.from)} ↔ ${escapeHtml(join.to)} · ${escapeHtml(details)}<small>Оценка ${Number(join.score || 0).toFixed(1)}/100 · ${escapeHtml(warning)}${flags.length ? ` · ${escapeHtml(flags.join(', '))}` : ''}</small></span>
      </div>
      <div class="join-actions">
        <button type="button" data-preview-join="${escapeHtml(join.id)}" title="Подсветить соединение на исходном чертеже">На схеме</button>
        <button type="button" data-join="${escapeHtml(join.id)}" title="Подтвердить и сохранить соединение">Подтвердить</button>
      </div>
    </div>`;
  }).join('');
  $('joinList').innerHTML = confirmedHtml + groupHtml + joinsHtml || '<div class="helper">Подходящих пар открытых концов не найдено. Кандидаты не добавляются автоматически.</div>';
  $('joinList').querySelectorAll('[data-compare-node]').forEach(button => button.addEventListener('click', () => {
    activeJoinGroupNode = button.dataset.compareNode;
    activeJoinId = null;
    renderOverlay();
    scrollToJoinPreview();
  }));
  $('joinList').querySelectorAll('[data-preview-join]').forEach(button => button.addEventListener('click', () => {
    activeJoinId = button.dataset.previewJoin;
    activeJoinGroupNode = null;
    renderJoinList();
    renderOverlay();
    scrollToJoinPreview();
  }));
  $('joinList').querySelectorAll('[data-join]').forEach(button => button.addEventListener('click', async () => {
    const candidate = graph.joinCandidates.find(item => item.id === button.dataset.join);
    if (!candidate) return;
    const competitors = graph.joinCandidates.filter(item => item.id !== candidate.id &&
      [candidate.from, candidate.to].some(nodeId => item.from === nodeId || item.to === nodeId));
    const competitorText = competitors.map(item => `${item.id}: ${item.from} ↔ ${item.to} (${Number(item.score || 0).toFixed(1)}/100)`).join('\n');
    const message = candidate.has_alternatives
      ? `Подтвердить только ${candidate.id}: ${candidate.from} ↔ ${candidate.to}?\n\nКонкурирующие варианты:\n${competitorText || 'см. список'}\n\nОценка ${Number(candidate.score || 0).toFixed(1)}/100 — это рейтинг, не вероятность. Решение сохранится в задании, а альтернативы с этими узлами будут сняты.`
      : `Подтвердить соединение ${candidate.from} ↔ ${candidate.to} (${candidate.distance} px) и сохранить его в задании?`;
    if (!window.confirm(message)) return;
    button.disabled = true;
    try {
      await persistManualConnection(candidate.from, candidate.to, { candidate });
      setAlert('');
    } catch (error) {
      setAlert(`Не удалось сохранить ${candidate.id}: ${error.message}`);
      setState('ОШИБКА СОХРАНЕНИЯ', 'error');
      button.disabled = false;
    }
  }));
}

async function persistReviewAction(payload) {
  if (!graph?.jobId) throw new Error('Сначала откройте сохранённое задание.');
  const response = await fetch(`/api/jobs/${encodeURIComponent(graph.jobId)}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  graph = normalizeGraph(data.graph);
  showResult();
}

function renderReviewList() {
  const list = $('reviewList');
  if (!list) return;
  const model = graph?.documentModel;
  if (!model) { list.innerHTML = '<div class="helper">Редактируемая модель отсутствует.</div>'; return; }
  const tasks = (model.reviewTasks || []).filter(item => item.status === 'open');
  const findings = (model.validationFindings || []).filter(item => item.status === 'open');
  $('reviewCount').textContent = String(tasks.length + findings.length);
  const catalogOptions = (graph.symbolCatalog || []).map(item => `<option value="${escapeHtml(item.type)}">${escapeHtml(item.label)}</option>`).join('');
  const pipeOptions = (model.pipes || []).filter(item => item.state === 'primary').map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.id)}</option>`).join('');
  const taskHtml = tasks.map(task => {
    const targetId = String((task.targetIds || [])[0] || '');
    let controls = `<button type="button" data-dismiss-task="${escapeHtml(task.id)}">Не учитывать</button>`;
    if (task.kind === 'classify_symbol') controls = `<select data-symbol-type="${escapeHtml(targetId)}"><option value="">Выберите тип…</option>${catalogOptions}</select><input data-symbol-rotation="${escapeHtml(targetId)}" type="number" min="0" max="359" value="0" title="Поворот"><button type="button" data-save-symbol="${escapeHtml(targetId)}">Сохранить</button>`;
    if (task.kind === 'assign_dimension') {
      const dimension = (model.dimensions || []).find(item => item.id === targetId) || {};
      controls = `<select data-dimension-pipe="${escapeHtml(targetId)}"><option value="">Выберите участок…</option>${pipeOptions}</select><input data-dimension-value="${escapeHtml(targetId)}" type="number" step="any" value="${escapeHtml(String(dimension.value ?? ''))}" title="Значение"><button type="button" data-save-dimension="${escapeHtml(targetId)}">Назначить</button>`;
    }
    if (task.kind === 'verify_text') {
      const label = (model.labels || []).find(item => item.id === targetId) || {};
      controls = `<input data-verified-text="${escapeHtml(targetId)}" type="text" value="${escapeHtml(label.text || '')}"><button type="button" data-save-text="${escapeHtml(targetId)}">Подтвердить</button>`;
    }
    return `<div class="rowitem review-action"><div class="review-action-main"><span class="id">${escapeHtml(task.id)}</span><span class="meta">${escapeHtml(task.message || task.kind)}<small>${escapeHtml(targetId)}</small></span></div><div class="review-controls">${controls}</div></div>`;
  }).join('');
  const findingHtml = findings.map(item => `<div class="rowitem review-action review-severity-${escapeHtml(item.severity || 'review')}"><div class="review-action-main"><span class="id">${escapeHtml(item.id)}</span><span class="meta">${escapeHtml(item.message || item.code)}<small>${escapeHtml((item.targetIds || []).join(', '))}</small></span></div><div class="review-controls"><button type="button" data-resolve-finding="${escapeHtml(item.id)}">Проверено</button></div></div>`).join('');
  list.innerHTML = taskHtml + findingHtml || '<div class="helper">Все замечания обработаны.</div>';

  const run = async (button, payload) => { button.disabled = true; try { await persistReviewAction(payload); setAlert(''); } catch (error) { setAlert(error.message); button.disabled = false; } };
  list.querySelectorAll('[data-save-symbol]').forEach(button => button.addEventListener('click', () => {
    const targetId = button.dataset.saveSymbol;
    run(button, { action: 'classify_symbol', targetId, symbolType: list.querySelector(`[data-symbol-type="${CSS.escape(targetId)}"]`)?.value, rotation: Number(list.querySelector(`[data-symbol-rotation="${CSS.escape(targetId)}"]`)?.value || 0) });
  }));
  list.querySelectorAll('[data-save-dimension]').forEach(button => button.addEventListener('click', () => {
    const targetId = button.dataset.saveDimension;
    run(button, { action: 'assign_dimension', targetId, pipeId: list.querySelector(`[data-dimension-pipe="${CSS.escape(targetId)}"]`)?.value, value: list.querySelector(`[data-dimension-value="${CSS.escape(targetId)}"]`)?.value });
  }));
  list.querySelectorAll('[data-save-text]').forEach(button => button.addEventListener('click', () => {
    const targetId = button.dataset.saveText;
    run(button, { action: 'verify_text', targetId, text: list.querySelector(`[data-verified-text="${CSS.escape(targetId)}"]`)?.value });
  }));
  list.querySelectorAll('[data-resolve-finding]').forEach(button => button.addEventListener('click', () => run(button, { action: 'resolve_finding', targetId: button.dataset.resolveFinding })));
  list.querySelectorAll('[data-dismiss-task]').forEach(button => button.addEventListener('click', () => run(button, { action: 'dismiss_task', targetId: button.dataset.dismissTask })));
}

function renderTextList() {
  const annotations = graph.annotations.filter(item => ['qwen3-vl', 'qwen3-vl-block', 'tesseract', 'openrouter-vision-ocr', 'moss-vl-ocr'].includes(item.source) && item.text);
  $('textList').innerHTML = annotations.length ? annotations.map(annotation => `
    <div class="rowitem"><input type="checkbox" data-include-annotation="${escapeHtml(annotation.id)}" ${((annotation.include ?? annotation.verified) ? 'checked' : '')} title="Заменить рукописную надпись CAD-текстом" aria-label="Заменить рукописную надпись ${escapeHtml(annotation.id)} CAD-текстом">
      <span class="id">${escapeHtml(annotation.id)}</span>
      <input type="text" data-text="${escapeHtml(annotation.id)}" value="${escapeHtml(annotation.text)}" aria-label="Текст ${escapeHtml(annotation.id)}">
      <span class="mini">${escapeHtml(String(annotation.confidence ?? 0))}% · ${annotation.source === 'qwen3-vl-block' ? 'Qwen · строка' : annotation.source === 'qwen3-vl' ? 'Qwen' : annotation.source === 'openrouter-vision-ocr' ? 'OpenRouter OCR' : annotation.source === 'moss-vl-ocr' ? 'MOSS-VL OCR' : 'Tesseract'}</span></div>`).join('') : '<div class="helper">Qwen3-VL, OpenRouter OCR и Tesseract не нашли читаемых подписей. Подтверждённый текст выводится как редактируемая CAD-надпись, а не как штрихи.</div>';
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
  if (showReviewText && (item.source === 'qwen3-vl-block' || (confidence >= 38 && item.text !== '?'))) return 'TEXT_REVIEW';
  return null;
}

function svgEscape(value) {
  return escapeHtml(value);
}
function buildCleanLayoutSvg(layout) {
  const template = layout.template || {};
  const fields = template.fields || {};
  const page = layout.page || {};
  const pageWidth = Number(page.width || 850);
  const pageHeight = Number(page.height || 1200);
  const widthMm = Number(page.widthMm || 210);
  const heightMm = Number(page.heightMm || 297);
  const landscape = pageHeight < pageWidth;
  const margin = Number(layout.frame?.margin || 18);
  const headerBottom = Number(layout.frame?.headerBottom || (landscape ? 132 : 150));
  const footerTop = Number(layout.frame?.footerTop || (landscape ? 680 : 936));
  const center = pageWidth / 2;
  const right = pageWidth - 30;
  const output = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${pageWidth} ${pageHeight}">`,
    `<rect width="${pageWidth}" height="${pageHeight}" fill="#fff"/>`,
    `<rect data-layer="SHEET" x="${margin}" y="${margin}" width="${pageWidth - margin * 2}" height="${pageHeight - margin * 2}" fill="none" stroke="#1c2329" stroke-width="1.1"/>`,
    `<line data-layer="SHEET" x1="${margin}" y1="${headerBottom}" x2="${pageWidth - margin}" y2="${headerBottom}" stroke="#1c2329" stroke-width=".75"/>`,
    `<line data-layer="SHEET" x1="${margin}" y1="${footerTop}" x2="${pageWidth - margin}" y2="${footerTop}" stroke="#68727b" stroke-width=".55"/>`
  ];
  const addSheetText = (value, x, y, anchor = 'start', size = 8, bold = false) => {
    if (!String(value || '').trim()) return;
    output.push(`<text data-layer="SHEET" x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${anchor}" font-family="Arial,sans-serif" font-size="${size}"${bold ? ' font-weight="bold"' : ''} fill="#15191d">${svgEscape(value)}</text>`);
  };
  const zones = template.zones || {};
  for (const [zoneName, zone] of Object.entries({ legend: zones.legend, signatures: zones.signatures })) {
    if (!zone || !['x','y','w','h'].every(key => Number.isFinite(Number(zone[key])))) continue;
    output.push(`<rect data-layer="SHEET_BLOCKS" data-zone="${zoneName}" x="${Number(zone.x)}" y="${Number(zone.y)}" width="${Number(zone.w)}" height="${Number(zone.h)}" fill="none" stroke="#68727b" stroke-width=".5"/>`);
  }
  const titleRows = landscape ? [28, 52, 79, 99, 119] : [36, 59, 91, 113, 137];
  addSheetText(fields.documentTitle, center, titleRows[0], 'middle', landscape ? 8.8 : 9.2, true);
  addSheetText(fields.appendix, right, titleRows[1], 'end', landscape ? 10 : 11, true);
  addSheetText(fields.title, center, titleRows[2], 'middle', 14, true);
  addSheetText(fields.subtitle, center, titleRows[3], 'middle', 9.5);
  if (fields.address) addSheetText(`по адресу: ${fields.address}`, center, titleRows[4], 'middle', 8.2);
  if (fields.documentNumber) addSheetText(`Обозначение: ${fields.documentNumber}`, 32, titleRows[4], 'start', 7.2);
  const scaleLabel = String(layout.scaleCalibration?.scaleLabel || '').trim();
  if (scaleLabel) addSheetText(scaleLabel, 32, landscape ? 145 : 165, 'start', 7.2, true);

  if (landscape) {
    const legendZone = zones.legend || { x: 50, y: 690 };
    const signatureZone = zones.signatures || { x: 790, y: 690 };
    addSheetText('УСЛОВНЫЕ ОБОЗНАЧЕНИЯ', Number(legendZone.x) + 8, Number(legendZone.y) + 15, 'start', 6.8, true);
    addSheetText('ПОДПИСИ', Number(signatureZone.x) + 8, Number(signatureZone.y) + 15, 'start', 6.8, true);
  } else {
    const legendZone = zones.legend || { x: pageWidth - 345, y: pageHeight - 254 };
    const signatureZone = zones.signatures || { x: pageWidth - 345, y: pageHeight - 116 };
    addSheetText('УСЛОВНЫЕ ОБОЗНАЧЕНИЯ', Number(legendZone.x) + 8, Number(legendZone.y) + 16, 'start', 6.8, true);
    addSheetText('ПОДПИСИ', Number(signatureZone.x) + 8, Number(signatureZone.y) + 15, 'start', 6.8, true);
  }
  (template.legend || []).forEach((item, index) => {
    if (landscape) {
      const column = index < 3 ? 0 : 1;
      const row = column === 0 ? index : index - 3;
      const x = column === 0 ? 48 : 410;
      const y = pageHeight - 90 + row * 25;
      addSheetText(item.code || '—', x, y, 'start', 7.2, true);
      addSheetText(item.label || '', x + 33, y, 'start', 6.8);
    } else {
      const legendZone = zones.legend || { x: pageWidth - 345, y: pageHeight - 254 };
      const x = Number(legendZone.x) + 12;
      const y = Number(legendZone.y) + 36 + index * 18;
      addSheetText(item.code || '—', x, y, 'start', 7.5, true);
      addSheetText(item.label || '', x + 32, y, 'start', 7);
    }
  });
  if (landscape) {
    const signatureZone = zones.signatures || { x: pageWidth - 410, y: pageHeight - 160 };
    const sx = Number(signatureZone.x) + 12, sy = Number(signatureZone.y) + 69;
    addSheetText(fields.preparedBy ? `Схему составил: ${fields.preparedBy}` : 'Схему составил', sx, sy - 35, 'start', 7.5);
    addSheetText(fields.drawnBy ? `Схему начертил: ${fields.drawnBy}` : 'Схему начертил', sx, sy - 13, 'start', 7.5);
    if (fields.checkedBy) addSheetText(`Проверил: ${fields.checkedBy}`, sx, sy + 9, 'start', 7.5);
  } else {
    const signatureZone = zones.signatures || { x: pageWidth - 345, y: pageHeight - 116 };
    const sx = Number(signatureZone.x) + 12;
    addSheetText(fields.preparedBy ? `Схему составил: ${fields.preparedBy}` : 'Схему составил', sx, Number(signatureZone.y) + 42, 'start', 7.5);
    addSheetText(fields.drawnBy ? `Схему начертил: ${fields.drawnBy}` : 'Схему начертил', sx, Number(signatureZone.y) + 62, 'start', 7.5);
    if (fields.checkedBy) addSheetText(`Проверил: ${fields.checkedBy}`, sx, Number(signatureZone.y) + 80, 'start', 7.5);
  }

  output.push('<g data-layer="PIPE_MAIN" fill="none" stroke="#15191d" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">');
  for (const pipe of (layout.pipes || [])) {
    const points = (pipe.geometry || []).map(point => `${Number(point[0]).toFixed(2)},${Number(point[1]).toFixed(2)}`).join(' ');
    if (points) output.push(`<polyline data-id="${svgEscape(pipe.id || '')}" points="${points}"/>`);
  }
  output.push('</g>');
  if (showReviewGeometry) {
    output.push('<g data-layer="DETAIL_REVIEW" fill="none" stroke="#929ba3" stroke-width=".75" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round">');
    for (const pipe of (layout.reviewPipes || [])) {
      const points = (pipe.geometry || []).map(point => `${Number(point[0]).toFixed(2)},${Number(point[1]).toFixed(2)}`).join(' ');
      if (points) output.push(`<polyline data-id="${svgEscape(pipe.id || '')}" points="${points}"/>`);
    }
    output.push('</g>');
  }
  output.push('<g data-layer="SYMBOLS" fill="none" stroke="#111" stroke-width="1" stroke-linejoin="round">');
  for (const symbol of (layout.symbols || [])) for (const primitive of (symbol.primitives || [])) {
    if (primitive.kind === 'line') output.push(`<line x1="${primitive.from[0]}" y1="${primitive.from[1]}" x2="${primitive.to[0]}" y2="${primitive.to[1]}"/>`);
    else if (primitive.kind === 'polyline') output.push(`<polyline points="${primitive.points.map(point => point.join(',')).join(' ')}"/>`);
    else if (primitive.kind === 'circle') output.push(`<circle cx="${primitive.center[0]}" cy="${primitive.center[1]}" r="${primitive.radius}"/>`);
  }
  output.push('</g>');
  for (const dimension of (layout.dimensions || [])) {
    const graphic = dimension.graphic || {};
    for (const [a, b] of (graphic.extensionLines || [])) output.push(`<line data-layer="DIMENSION_LINES" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#303840" stroke-width=".65"/>`);
    if (graphic.dimensionLine?.length === 2) {
      const [a, b] = graphic.dimensionLine;
      output.push(`<line data-layer="DIMENSION_LINES" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#303840" stroke-width=".75"/>`);
    }
    for (const arrow of (graphic.arrowLines || [])) if (arrow.length === 2) {
      output.push(`<line data-layer="DIMENSION_LINES" x1="${arrow[0][0]}" y1="${arrow[0][1]}" x2="${arrow[1][0]}" y2="${arrow[1][1]}" stroke="#303840" stroke-width=".75"/>`);
    }
    const position = dimension.position || graphic.textPosition || [0, 0];
    output.push(`<text data-layer="DIMENSIONS" x="${position[0]}" y="${position[1]}" text-anchor="middle" font-family="Arial,sans-serif" font-size="8" paint-order="stroke" stroke="#fff" stroke-width="3" fill="#15191d">${svgEscape(dimension.displayText ?? dimension.rawText ?? dimension.value ?? '')}</text>`);
  }
  for (const label of (layout.labels || [])) {
    const position = label.position || [0, 0];
    output.push(`<text data-layer="LABELS" x="${position[0]}" y="${position[1]}" text-anchor="middle" font-family="Arial,sans-serif" font-size="8.2" paint-order="stroke" stroke="#fff" stroke-width="2.8" fill="#20262b">${svgEscape(label.text || '')}</text>`);
  }
  for (const tag of (layout.sectionTags || [])) {
    const box = tag.bbox || {}, position = tag.position || [0, 0];
    output.push(`<rect data-layer="SECTION_TAGS" data-provisional="true" data-target="${svgEscape(tag.targetId || '')}" x="${box.x ?? position[0] - 8}" y="${box.y ?? position[1] - 7}" width="${box.w ?? 16}" height="${box.h ?? 13}" fill="#fff" stroke="#1d252c" stroke-width=".75"/>`);
    output.push(`<text data-layer="SECTION_TAGS" data-provisional="true" x="${position[0]}" y="${position[1] + 2.6}" text-anchor="middle" font-family="Arial,sans-serif" font-size="7.3" font-weight="bold" fill="#15191d">${svgEscape(tag.number || '')}</text>`);
  }
  if (layout.reviewOnly) addSheetText('НЕПОЛНЫЙ РЕЗУЛЬТАТ — ТОЛЬКО ПРОВЕРКА', center, pageHeight - 25, 'middle', 10, true);
  if ((layout.sectionTags || []).length) addSheetText('Нумерация участков предложена автоматически — подтвердить перед выпуском.', 28, pageHeight - 28, 'start', 6.2);
  output.push('</svg>');
  return output.join('\n');
}
function buildSheetSvg() {
  if (['cad-clean-layout/1.0', 'cad-clean-layout/1.1', 'cad-clean-layout/1.2'].includes(graph.cleanLayout?.schema)) return buildCleanLayoutSvg(graph.cleanLayout);
  const width = graph.image.width;
  const height = graph.image.height;
  const pageWidth = 1200, pageHeight = 850;
  const drawX = 36, drawY = 88, drawW = 1128, drawH = 652;
  const scale = Math.min(drawW / Math.max(1, width), drawH / Math.max(1, height));
  const offsetX = drawX + (drawW - width * scale) / 2;
  const offsetY = drawY + (drawH - height * scale) / 2;
  const chains = cleanCadChains();
  const reviewEdges = showReviewGeometry ? graph.edges.filter(edge =>
    edge.visible !== false && !isPrimaryCadEdge(edge) &&
    edge.component_role !== 'text_or_annotation' && edge.suggested_role !== 'text_or_dimension'
  ) : [];
  const reviewChains = reviewEdges.length ? buildChains(reviewEdges).map(chain => ({ ...chain, points: cleanCadPoints(chain.points) })) : [];
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
    `<g transform="translate(${offsetX} ${offsetY}) scale(${scale})" fill="none" stroke="#b7c0c8" stroke-width="${Math.max(.14, .34 / Math.max(scale, .001))}" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round">`
  ];
  for (const chain of reviewChains) {
    const points = chain.points.map(point => `${point[0]},${point[1]}`).join(' ');
    output.push(`<polyline data-layer="DETAIL_REVIEW" points="${points}"/>`);
  }
  output.push('</g>');
  if (showReviewGeometry) {
    const primaryRouteIds = new Set((graph.primarySemanticRoutes || []).map(route => String(route.id)));
    const qwenReviewRoutes = (graph.semanticRoutes || []).filter(route =>
      !route.primary_validated && !primaryRouteIds.has(String(route.id)) &&
      Number(route.confidence ?? 0) >= 20 && Array.isArray(route.points) && route.points.length >= 2 &&
      route.points.every(point => Array.isArray(point) && point.length >= 2 &&
        Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])) &&
        Number(point[0]) >= 0 && Number(point[0]) <= width &&
        Number(point[1]) >= 0 && Number(point[1]) <= height)
    );
    if (qwenReviewRoutes.length) {
      output.push(`<g data-layer="QWEN_REVIEW" transform="translate(${offsetX} ${offsetY}) scale(${scale})" fill="none" stroke="#9678a9" stroke-width="${Math.max(.13, .34 / Math.max(scale, .001))}" stroke-dasharray="7 5" stroke-linecap="round" stroke-linejoin="round">`);
      for (const route of qwenReviewRoutes) {
        const points = route.points.map(point => `${Number(point[0])},${Number(point[1])}`).join(' ');
        if (points) output.push(`<polyline points="${points}"/>`);
      }
      output.push('</g>');
    }
  }
  output.push(`<g transform="translate(${offsetX} ${offsetY}) scale(${scale})" fill="none" stroke="#17212b" stroke-width="${Math.max(.18, .62 / Math.max(scale, .001))}" stroke-linecap="round" stroke-linejoin="round">`);
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
    // Block OCR boxes can span an entire handwritten row. Anchor at the
    // original row's left edge so its numbers do not collapse toward centre.
    const x = offsetX + box.x * scale;
    const y = offsetY + (box.y + box.h) * scale;
    const labelWidth = Math.max(24, Math.min(220, String(annotation.text).length * 4.8 + 8));
    const color = layer === 'VERIFIED_TEXT' ? '#15191d' : '#8b6334';
    const fontSize = layer === 'VERIFIED_TEXT' ? 8 : 7;
    const weight = layer === 'VERIFIED_TEXT' ? '600' : '400';
    output.push(`<text data-layer="${layer}" x="${x}" y="${y + 1}" text-anchor="start" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${color}" style="paint-order:stroke;stroke:#fff;stroke-width:2px;stroke-linejoin:round">${svgEscape(annotation.text)}</text>`);
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

function setOutputViewMode(mode) {
  outputViewMode = ['original', 'centerline', 'reference', 'cad'].includes(mode) ? mode : 'original';
  for (const [id, key] of [['originalSourceView', 'original'], ['centerlineTraceView', 'centerline'], ['referenceTraceView', 'reference'], ['cadDraftView', 'cad']]) {
    const button = $(id);
    if (!button) continue;
    button.classList.toggle('active', outputViewMode === key);
    button.setAttribute('aria-pressed', String(outputViewMode === key));
  }
  syncOutputExportButtons();
  renderClean();
}

function renderClean() {
  if (!graph) return;
  if (graph.manualCadProjectId && graph.manualCadPreviewUrl) {
    const button = $('openManualCadBtn');
    button.hidden = false; button.disabled = false;
    button.dataset.projectId = graph.manualCadProjectId;
    return;
  }
  $('cleanStage').classList.remove('manual-cad-preview');
  if (outputViewMode === 'original' && graph.sourceUrl) {
    $('cleanStage').classList.add('manual-cad-preview');
    $('cleanStage').innerHTML = `<img class="manual-cad-preview-image source-original-preview" src="${escapeHtml(graph.sourceUrl)}?v=${Date.now()}" alt="Исходная фотография схемы без векторных искажений" loading="eager"><div class="manual-cad-preview-caption"><b>ИСХОДНИК · КОНТРОЛЬНЫЙ ЭТАЛОН</b><span>Показано исходное изображение. Автоматическая CAD-реконструкция не прошла проверки качества; сырые линии не выдаются за готовую схему.</span></div>`;
    $('cleanStage').querySelector('img')?.addEventListener('error', () => {
      $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><b>Не удалось загрузить исходное изображение</b><span>Проверь ссылку sourceUrl в диагностике.</span></div>';
    });
    return;
  }
  if (outputViewMode === 'centerline' && graph.centerlineTrace?.available && graph.centerlineTraceSvgUrl) {
    const trace = graph.centerlineTrace;
    $('cleanStage').classList.add('manual-cad-preview');
    $('cleanStage').innerHTML = `<img class="manual-cad-preview-image reference-trace-image centerline-trace-image" src="${escapeHtml(graph.centerlineTraceSvgUrl)}?v=${Date.now()}" alt="Линейная векторизация исходного чертежа" loading="eager"><div class="manual-cad-preview-caption"><b>ЛИНЕЙНАЯ ВЕКТОРИЗАЦИЯ · ОТКРЫТЫЕ ПОЛИЛИНИИ</b><span>${Number(trace.paths || 0).toLocaleString('ru-RU')} полилиний · ${Number(trace.vertices || 0).toLocaleString('ru-RU')} вершин · исходные штрихи без замкнутых контуров; это не подтверждённая топология труб</span></div>`;
    $('cleanStage').querySelector('img')?.addEventListener('error', () => {
      $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><b>Не удалось загрузить линейную векторизацию</b><span>Проверь centerline-trace.svg в диагностике.</span></div>';
    });
    return;
  }
  if (outputViewMode === 'reference' && graph.referenceTrace?.available && graph.referenceTraceSvgUrl) {
    const trace = graph.referenceTrace;
    $('cleanStage').classList.add('manual-cad-preview');
    $('cleanStage').innerHTML = `<img class="manual-cad-preview-image reference-trace-image" src="${escapeHtml(graph.referenceTraceSvgUrl)}?v=${Date.now()}" alt="Редактируемая векторная копия исходного чертежа" loading="eager"><div class="manual-cad-preview-caption"><b>ВЕКТОРНАЯ КОПИЯ ОРИГИНАЛА</b><span>${Number(trace.components || 0).toLocaleString('ru-RU')} компонентов · ${Number(trace.contours || 0).toLocaleString('ru-RU')} контуров · внешний вид сохранён, трубная топология не подтверждена</span></div>`;
    $('cleanStage').querySelector('img')?.addEventListener('error', () => {
      $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><b>Не удалось загрузить векторную копию</b><span>Проверь ссылку на reference-trace.svg в диагностике.</span></div>';
    });
    return;
  }
  if (outputViewMode === 'cad' && (graph.cadDraftSvgUrl || graph.svgUrl)) {
    const draftUrl = graph.cadDraftSvgUrl || graph.svgUrl;
    const completeness = !assessCadReadiness(graph).ready
      ? 'CAD-ЧЕРНОВИК · НЕ ПРОШЁЛ ПРОВЕРКИ КАЧЕСТВА'
      : graph.complete === false ? 'ЧЕРНОВИК · НЕПОЛНЫЙ РЕЗУЛЬТАТ' : 'CAD-ЧЕРНОВИК · НУЖНА ИНЖЕНЕРНАЯ ПРОВЕРКА';
    $('cleanStage').classList.add('manual-cad-preview');
    $('cleanStage').innerHTML = `<img class="manual-cad-preview-image cad-draft-preview-image" src="${escapeHtml(draftUrl)}?v=${Date.now()}" alt="CAD-реконструкция исходной схемы" loading="eager"><div class="manual-cad-preview-caption"><b>${completeness}</b><span>${Number(graph.summary?.cad_primary_edges || 0).toLocaleString('ru-RU')} основных CAD-сегментов · ${Number(graph.summary?.crossings_to_review || 0).toLocaleString('ru-RU')} пересечений на проверку · контуры оборудования и соединения сверить с оригиналом</span></div>`;
    $('cleanStage').querySelector('img')?.addEventListener('error', () => {
      $('cleanStage').innerHTML = '<div class="stage-empty clean-empty"><b>Не удалось загрузить CAD-черновик</b><span>Открой диагностику обработки или переключись на копию оригинала.</span></div>';
    });
    return;
  }
  const visible = shownEdges();
  const hasIncludedText = graph.annotations.some(item => annotationExportLayer(item));
  const hasReviewGeometry = showReviewGeometry && (graph.edges.some(edge => edge.visible !== false && !isPrimaryCadEdge(edge) && edge.component_role !== 'text_or_annotation' && edge.suggested_role !== 'text_or_dimension') || (graph.semanticRoutes || []).some(route => !route.primary_validated && Number(route.confidence ?? 0) >= 20 && Array.isArray(route.points) && route.points.length >= 2));
  if (!visible.length && !(graph.semanticRoutes || []).length && !hasIncludedText && !hasReviewGeometry) {
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
  for (const route of (graph.semanticRoutes || []).filter(item => !item.primary_validated && Number(item.confidence ?? 0) >= 20 && Array.isArray(item.points) && item.points.length >= 2 && item.points.every(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])) && Number(point[0]) >= 0 && Number(point[0]) <= graph.image.width && Number(point[1]) >= 0 && Number(point[1]) <= graph.image.height))) {
    const points = (route.points || []).map(point => [offsetX + Number(point[0]) * scale, offsetY + Number(point[1]) * scale]);
    addPolyline('QWEN_REVIEW',points,false,9);
  }
  for (const annotation of graph.annotations.filter(item => annotationExportLayer(item))) {
    const layer = annotationExportLayer(annotation);
    const box = annotation.bbox;
    // Block OCR boxes can span an entire handwritten row. Anchor at the
    // original row's left edge so its numbers do not collapse toward centre.
    const x = offsetX + box.x * scale;
    const y = offsetY + (box.y + box.h) * scale;
    const widthMm = Math.min(70, String(annotation.text).length * 1.65);
    addText(layer,annotation.text,[x,y],layer === 'VERIFIED_TEXT' ? 3.0 : 2.7);
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
function finalExportAllowed() {
  return Boolean(graph && graph.complete !== false && graph.analysisStatus !== 'incomplete');
}
function rejectPartialExport() {
  setAlert('Экспорт SVG/DXF/PDF запрещён: обработка неполная. Повтори преобразование, чтобы продолжить с сохранённых checkpoint. JSON остаётся доступен для диагностики.');
}
async function ensureSourceOnlyHouseCadProject(jobId) {
  const response = await fetch(`/api/library/schemes/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось получить исходную фотографию.');
  const image = new Image();
  image.src = `${data.scheme.sourceUrl}?dimensions=${Date.now()}`;
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Не удалось определить размер исходной фотографии.'));
  });
  const createResponse = await fetch(`/api/manual-cad/import-source-job/${encodeURIComponent(jobId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: activeScheme?.title || data.scheme.title || 'Схема дома',
      width: image.naturalWidth, height: image.naturalHeight
    })
  });
  const projectData = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok) throw new Error(projectData.error || 'Не удалось создать ручной CAD-проект.');
  return projectData.project;
}

$('openManualCadBtn').addEventListener('click', async () => {
  const jobId = graph?.jobId || activeScheme?.jobId;
  if (!jobId) return;
  const button = $('openManualCadBtn');
  button.disabled = true;
  button.innerHTML = '<b>CAD</b><span>Открываю…</span>';
  try {
    let projectId = graph?.manualCadProjectId || button.dataset.projectId;
    if (!projectId) {
      const project = graph
        ? await ensureHouseSchemeCadProject(jobId)
        : await ensureSourceOnlyHouseCadProject(jobId);
      projectId = project?.id;
    }
    if (!projectId) throw new Error('Не удалось подготовить CAD-проект по этой фотографии.');
    window.location.href = `/manual-cad.html?project=${encodeURIComponent(projectId)}`;
  } catch (error) {
    setAlert(`Не удалось открыть CAD-редактор: ${error.message}`);
    button.disabled = false;
    button.innerHTML = '<b>CAD</b><span>Повторить</span>';
  }
});

function downloadJobArtifact(url, filename) {
  if (!url) return false;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  return true;
}
$('originalSourceView')?.addEventListener('click', () => setOutputViewMode('original'));
$('centerlineTraceView')?.addEventListener('click', () => setOutputViewMode('centerline'));
$('referenceTraceView')?.addEventListener('click', () => setOutputViewMode('reference'));
$('cadDraftView')?.addEventListener('click', () => setOutputViewMode('cad'));
$('exportSvg').addEventListener('click', () => {
  if (outputViewMode === 'centerline' && graph?.centerlineTrace?.available && graph?.centerlineTraceSvgUrl) {
    downloadJobArtifact(graph.centerlineTraceSvgUrl, 'source-centerline-polylines.svg');
    return;
  }
  if (outputViewMode === 'reference' && graph?.referenceTrace?.available && graph?.referenceTraceSvgUrl) {
    downloadJobArtifact(graph.referenceTraceSvgUrl, 'source-contours.svg');
    return;
  }
  if (graph?.cadDraftSvgUrl) downloadJobArtifact(graph.cadDraftSvgUrl, 'cad-reconstruction-draft.svg');
  else if (finalExportAllowed()) downloadFile('cad-reconstruction-draft.svg', buildSheetSvg(), 'image/svg+xml');
  else rejectPartialExport();
});
$('exportDxf').addEventListener('click', () => {
  if (outputViewMode === 'centerline' && graph?.centerlineTrace?.available && graph?.centerlineTraceDxfUrl) {
    downloadJobArtifact(graph.centerlineTraceDxfUrl, 'source-centerline-polylines.dxf');
    return;
  }
  if (outputViewMode === 'reference' && graph?.referenceTrace?.available && graph?.referenceTraceDxfUrl) {
    downloadJobArtifact(graph.referenceTraceDxfUrl, 'source-contours.dxf');
    return;
  }
  if (graph?.cadDraftDxfUrl) downloadJobArtifact(graph.cadDraftDxfUrl, 'cad-reconstruction-draft.dxf');
  else if (graph?.dxfUrl && graph?.cleanLayout) downloadJobArtifact(graph.dxfUrl, 'cad-reconstruction-draft.dxf');
  else if (finalExportAllowed()) downloadFile('cad-reconstruction-draft.dxf', buildDxf(), 'application/dxf');
  else rejectPartialExport();
});
$('exportJson').addEventListener('click', () => downloadFile('reconstruction-graph.json', JSON.stringify(graph, null, 2), 'application/json'));
$('exportPdf').addEventListener('click', () => {
  if (outputViewMode === 'original' && graph?.sourceUrl) {
    const popup = window.open('', '_blank');
    if (!popup) { setAlert('Разреши всплывающие окна, чтобы открыть печать в PDF.'); return; }
    const sourceWidth = Number(graph.image?.width || 0);
    const sourceHeight = Number(graph.image?.height || 0);
    const widthMm = sourceWidth >= sourceHeight ? 297 : 210;
    const heightMm = sourceWidth >= sourceHeight ? 210 : 297;
    const sourceUrl = `${graph.sourceUrl}?print=${Date.now()}`;
    popup.document.open();
    popup.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Исходная схема</title><style>@page{size:${widthMm}mm ${heightMm}mm;margin:0}html,body{margin:0;padding:0;width:${widthMm}mm;height:${heightMm}mm}img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><img src="${escapeHtml(sourceUrl)}" alt="Исходная схема"><script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script></body></html>`);
    popup.document.close();
    return;
  }
  const selectedSourceTrace = outputViewMode === 'centerline'
    ? { meta: graph?.centerlineTrace, url: graph?.centerlineTraceSvgUrl, title: 'Линейная векторизация исходной схемы' }
    : outputViewMode === 'reference'
      ? { meta: graph?.referenceTrace, url: graph?.referenceTraceSvgUrl, title: 'Векторная копия исходной схемы' }
      : null;
  const hasTrace = Boolean(selectedSourceTrace?.meta?.available && selectedSourceTrace?.url);
  const hasCadDraft = Boolean(graph?.cadDraftSvgUrl || graph?.svgUrl);
  if (!hasTrace && !hasCadDraft && !finalExportAllowed()) return rejectPartialExport();
  const popup = window.open('', '_blank');
  if (!popup) { setAlert('Разреши всплывающие окна, чтобы открыть печать в PDF.'); return; }
  popup.document.open();
  if (hasTrace) {
    const widthMm = Number(selectedSourceTrace.meta.pageWidthMm || 210);
    const heightMm = Number(selectedSourceTrace.meta.pageHeightMm || 297);
    const sourceUrl = `${selectedSourceTrace.url}?print=${Date.now()}`;
    popup.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(selectedSourceTrace.title)}</title><style>@page{size:${widthMm}mm ${heightMm}mm;margin:0}html,body{margin:0;padding:0;width:${widthMm}mm;height:${heightMm}mm}img{display:block;width:${widthMm}mm;height:${heightMm}mm;object-fit:contain}</style></head><body><img src="${escapeHtml(sourceUrl)}" alt="Исходная схема"><script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script></body></html>`);
  } else {
    const page = graph.cleanLayout?.page || {};
    const widthMm = Number(page.widthMm || 297);
    const heightMm = Number(page.heightMm || 210);
    const draftUrl = graph.cadDraftSvgUrl || graph.svgUrl;
    const body = draftUrl ? `<img src="${escapeHtml(draftUrl)}?print=${Date.now()}" alt="CAD-черновик">` : buildSheetSvg();
    popup.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>CAD-черновик ВДГО</title><style>@page{size:${widthMm}mm ${heightMm}mm;margin:0}html,body{margin:0;padding:0;width:${widthMm}mm;height:${heightMm}mm}svg,img{display:block;width:${widthMm}mm;height:${heightMm}mm;object-fit:contain}</style></head><body>${body}<script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script></body></html>`);
  }
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
async function restoreSavedJobFromUrl() {
  const jobId = new URLSearchParams(window.location.search).get('job');
  if (!jobId) return;
  await openLibraryScheme(jobId);
}


// Global drawing-style reference. This is stored separately from house uploads.
const templateFileInput = $('templateFileInput');
const templateUploadBtn = $('templateUploadBtn');
const templateDeleteBtn = $('templateDeleteBtn');
let selectedTemplateFile = null;

function setTemplateMessage(message = '', kind = '') {
  const box = $('templateMessage');
  if (!box) return;
  box.textContent = message;
  box.dataset.kind = kind;
}

function renderTemplateInfo(template) {
  const root = $('templateCurrent');
  if (!root) return;
  if (!template) {
    root.innerHTML = '<span class="template-current-empty">Эталон ещё не загружен</span>';
    templateDeleteBtn.hidden = true;
    return;
  }
  const date = template.uploadedAt ? new Date(template.uploadedAt).toLocaleString('ru-RU') : '';
  root.innerHTML = `<div class="template-current-file"><span class="template-file-mark">${escapeHtml((template.originalName.split('.').pop() || 'ФАЙЛ').toUpperCase())}</span><span class="template-file-info"><b>${escapeHtml(template.originalName)}</b><small>${formatBytes(template.size || 0)}${date ? ` · ${escapeHtml(date)}` : ''}</small></span></div><a class="template-download" href="${escapeHtml(template.downloadUrl || '/api/template/file')}" download>Скачать</a>`;
  templateDeleteBtn.hidden = false;
}

async function loadTemplateInfo() {
  try {
    const response = await fetch('/api/template', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Не удалось загрузить сведения о шаблоне.');
    renderTemplateInfo(data.template || null);
  } catch (error) {
    setTemplateMessage(error.message || 'Не удалось проверить шаблон.', 'error');
  }
}

if (templateFileInput) {
  templateFileInput.addEventListener('change', () => {
    selectedTemplateFile = templateFileInput.files?.[0] || null;
    $('templateSelectedName').textContent = selectedTemplateFile
      ? `${selectedTemplateFile.name} · ${formatBytes(selectedTemplateFile.size)}`
      : 'PDF, SVG, DXF или изображение · до 30 МБ';
    templateUploadBtn.disabled = !selectedTemplateFile || selectedTemplateFile.size > 30 * 1024 * 1024;
    setTemplateMessage(selectedTemplateFile?.size > 30 * 1024 * 1024 ? 'Файл больше 30 МБ.' : '');
  });

  templateUploadBtn.addEventListener('click', async () => {
    if (!selectedTemplateFile || templateUploadBtn.disabled) return;
    const form = new FormData();
    form.append('template', selectedTemplateFile);
    templateUploadBtn.disabled = true;
    templateUploadBtn.textContent = 'Сохранение…';
    setTemplateMessage('Загружаю эталон в постоянное хранилище сервера…');
    try {
      const response = await fetch('/api/template', { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить шаблон.');
      selectedTemplateFile = null;
      templateFileInput.value = '';
      $('templateSelectedName').textContent = 'PDF, SVG, DXF или изображение · до 30 МБ';
      renderTemplateInfo(data.template || null);
      setTemplateMessage('Шаблон сохранён. Он не попадёт во входящие домов и не запустит распознавание.', 'success');
    } catch (error) {
      setTemplateMessage(error.message || 'Не удалось сохранить шаблон.', 'error');
    } finally {
      templateUploadBtn.textContent = 'Сохранить шаблон';
      templateUploadBtn.disabled = !selectedTemplateFile;
    }
  });

  templateDeleteBtn.addEventListener('click', async () => {
    if (!window.confirm('Удалить общий эталон оформления?')) return;
    templateDeleteBtn.disabled = true;
    try {
      const response = await fetch('/api/template', { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось удалить шаблон.');
      renderTemplateInfo(null);
      setTemplateMessage('Эталон удалён.', 'success');
    } catch (error) {
      setTemplateMessage(error.message || 'Не удалось удалить шаблон.', 'error');
    } finally {
      templateDeleteBtn.disabled = false;
    }
  });
}


async function refreshRecognitionStatus() {
  const button = $('refreshRecognitionStatus');
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const health = await response.json();
    if (!response.ok) throw new Error(health.error || 'Не удалось проверить локальные распознаватели.');
    const qwen = health.ollama || {};
    const tess = health.localRecognition?.tesseract || {};
    const qwenReady = qwen.reachable && qwen.modelInstalled;
    const tessReady = tess.available && tess.russianEnglishReady;
    $('qwenHealthState').textContent = !qwen.reachable ? 'Ollama недоступна' : qwen.modelInstalled ? 'Модель установлена' : 'Модель не установлена';
    $('qwenHealthDetail').textContent = qwenReady ? `${health.qwenModel} · серверная модель` : (qwen.hint || qwen.error || health.qwenModel);
    $('tesseractHealthState').textContent = tessReady ? 'Готов · rus + eng' : tess.available ? 'Нет языкового пакета' : 'Недоступен';
    $('tesseractHealthDetail').textContent = tessReady ? `Языки: ${(tess.languages || []).join(', ')}` : (tess.error || 'Установите tesseract-ocr-rus и tesseract-ocr-eng.');
    $('qwenHealthCard').dataset.state = qwenReady ? 'ready' : 'warning';
    $('tesseractHealthCard').dataset.state = tessReady ? 'ready' : 'warning';
    $('serverState').textContent = qwenReady ? (tessReady ? 'Qwen + OCR готовы' : 'Qwen готов · OCR требует проверки') : 'Проверь Qwen';
    $('serverState').title = [qwen.error, tess.error].filter(Boolean).join(' · ') || `Локальный режим: ${health.qwenModel} + Tesseract`;
  } catch (error) {
    $('serverState').textContent = 'Ошибка проверки';
    $('serverState').title = error.message || 'Не удалось проверить локальный режим';
    $('qwenHealthState').textContent = 'Нет связи с сервером';
    $('tesseractHealthState').textContent = 'Нет связи с сервером';
  } finally {
    if (button) button.disabled = false;
  }
}

$('refreshRecognitionStatus')?.addEventListener('click', refreshRecognitionStatus);
refreshRecognitionStatus();

loadAddressLibrary();
loadTemplateInfo();
if (!workspaceView) restoreSavedJobFromUrl();

const compareFullscreen = $('compareFullscreen');
const comparison = compareFullscreen.closest('.main-column');
compareFullscreen.addEventListener('click', async () => {
  const status = $('compareFullscreenStatus');
  status.hidden = true;
  try {
    if (document.fullscreenElement === comparison) await document.exitFullscreen();
    else await comparison.requestFullscreen();
  } catch {
    status.textContent = 'Полноэкранный режим недоступен в этом браузере.';
    status.hidden = false;
  }
});
document.addEventListener('fullscreenchange', () => {
  compareFullscreen.textContent = document.fullscreenElement === comparison ? 'Свернуть' : 'На весь экран';
  requestAnimationFrame(fitImageFrame);
});
