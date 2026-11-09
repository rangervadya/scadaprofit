import { prepareInkTrace, traceInkRoute } from './manual-cad-ink-trace.js';

const $ = id => document.getElementById(id);
const svg = $('cadCanvas');
const state = {
  projects: [], project: null, tool: 'select', selected: null,
  draft: [], draftStart: null, draftEnd: null, dimensionStart: null,
  sourceVisible: true, showReviewCandidates: false, saveTimer: null, saveChain: Promise.resolve(),
  undo: [], redo: [], drag: null, activeVertex: null, justDragged: false, lastSaved: null, toastTimer: null, zoom: 1, ortho: false,
  traceRaster: null, traceLastPoint: null, traceSegments: 0, traceMetrics: [], traceSegmentStartIndices: [], traceWaypoints: [], traceAttachments: [], traceBusy: false
};

function uid(prefix='item') { return `${prefix}_${(globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`).replaceAll('-', '')}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function safeNum(value, fallback=0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function projectId() { return state.project?.id || ''; }
function setSaveState(message, kind='') {
  const el = $('saveState'); el.textContent = message; el.dataset.kind = kind;
}
function toast(message) {
  const el = $('mcToast'); el.textContent = message; el.classList.add('is-visible');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}
async function api(url, options={}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  let data = {};
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) data = await response.json();
  if (!response.ok) throw new Error(data.error || `Ошибка сервера (${response.status})`);
  return data;
}

function ensureProjectDefaults(project) {
  project.width = Math.max(100, safeNum(project.width, 1600));
  project.height = Math.max(100, safeNum(project.height, 1000));
  project.pipes ||= []; project.junctions ||= []; project.symbols ||= []; project.labels ||= []; project.dimensions ||= [];
  project.sketchAssist ||= null;
  project.pipes.forEach(pipe => { pipe.reviewOnly = pipe.reviewOnly === true; pipe.reviewReason ||= ''; });
  project.symbols.forEach(symbol => { symbol.reviewOnly = symbol.reviewOnly === true; symbol.reviewReason ||= ''; });
  project.page = project.page === 'landscape' ? 'landscape' : 'portrait';
  project.paperSize = project.paperSize === 'A3' ? 'A3' : 'A4';
  project.drawingStyle = project.drawingStyle === 'lpgcad-r1' ? 'lpgcad-r1' : 'standard';
  project.siteAddress ||= '';
  project.entrance ||= '';
  project.inspectionTitle ||= 'Заключение по результатам технического диагностирования внутридомового газового оборудования';
  if (!project.schemeSubtitle || project.schemeSubtitle === 'Схема неразрушающего контроля внутридомового газового оборудования') project.schemeSubtitle = 'неразрушающего контроля внутридомового газового оборудования';
  project.riserGroups = Array.isArray(project.riserGroups) ? project.riserGroups : [];
  project.schemeAuthor ||= '';
  project.schemeChecker ||= '';
  return project;
}

async function loadProjects(preferId=null) {
  try {
    const data = await api('/api/manual-cad/projects');
    state.projects = data.projects || [];
    renderProjectList();
    $('projectCount').textContent = String(state.projects.length);
    const target = preferId || state.projects[0]?.id;
    if (target) await openProject(target);
    else await createProject(false);
  } catch (error) {
    setSaveState('Ошибка списка', 'error'); toast(error.message);
    $('projectList').innerHTML = `<div class="mc-muted-block">${esc(error.message)}</div>`;
  }
}
function renderProjectList() {
  $('projectList').innerHTML = state.projects.length ? state.projects.map(item => `
    <button class="mc-project-item ${item.id === projectId() ? 'is-active' : ''}" data-project-id="${esc(item.id)}" type="button">
      <b>${esc(item.title || 'Без названия')}</b>
      <small>${new Date(item.updatedAt || item.createdAt || Date.now()).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'})} · ${item.pipeCount || 0} труб</small>
    </button>`).join('') : '<div class="mc-muted-block">Пока нет чертежей. Создай первый проект.</div>';
  $('projectList').querySelectorAll('[data-project-id]').forEach(button => button.addEventListener('click', () => openProject(button.dataset.projectId)));
}
async function createProject(showToast=true) {
  try {
    const data = await api('/api/manual-cad/projects', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ title: 'Новая схема' }) });
    state.project = ensureProjectDefaults(data.project);
    state.traceRaster = null;
    state.undo = []; state.redo = []; state.selected = null; state.activeVertex = null; clearDraft(); state.showReviewCandidates = false;
    await refreshProjectList();
    syncControls(); renderAll();
    if (showToast) toast('Создан новый чертёж. Загрузи исходный эскиз или начни строить схему.');
  } catch (error) { toast(error.message); }
}
async function refreshProjectList() {
  const data = await api('/api/manual-cad/projects');
  state.projects = data.projects || [];
  $('projectCount').textContent = String(state.projects.length);
  renderProjectList();
}
async function openProject(id) {
  try {
    const data = await api(`/api/manual-cad/projects/${encodeURIComponent(id)}`);
    state.project = ensureProjectDefaults(data.project);
    state.undo = []; state.redo = []; state.selected = null; state.activeVertex = null; clearDraft(); state.sourceVisible = true; state.showReviewCandidates = Boolean(state.project.sketchAssist?.enabled && state.project.pipes.some(pipe => pipe.reviewOnly));
    await loadTraceRaster(state.project);
    syncControls(); renderAll(); setSaveState('Сохранено', 'saved'); await refreshProjectList();
  } catch (error) { toast(error.message); }
}


async function loadTraceRaster(project) {
  state.traceRaster = null;
  if (!project?.sourceUrl) return;
  try {
    const image = new Image();
    image.decoding = 'async';
    const src = `${project.sourceUrl}?trace=${encodeURIComponent(project.source?.uploadedAt || Date.now())}`;
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Не удалось загрузить изображение для автотрассы.'));
      image.src = src;
    });
    const scale = Math.min(1, 1500 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(2, Math.round(image.naturalWidth * scale));
    const height = Math.max(2, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const prepared = prepareInkTrace({ data: pixels.data, width, height, step: 2, maxDimension: 1500 });
    state.traceRaster = {
      prepared,
      scaleX: project.width / prepared.width,
      scaleY: project.height / prepared.height
    };
  } catch (error) {
    state.traceRaster = null;
    console.warn('Manual CAD ink trace raster unavailable:', error);
  }
}

function mapProjectPointToTrace(point) {
  const raster = state.traceRaster;
  return raster ? { x: point.x / raster.scaleX, y: point.y / raster.scaleY } : null;
}
function mapTracePointToProject(pair) {
  const raster = state.traceRaster;
  return raster ? { x: pair[0] * raster.scaleX, y: pair[1] * raster.scaleY } : null;
}

async function addInkTraceWaypoint(point) {
  if (!state.traceRaster) {
    toast('Сначала загрузи фотографию в качестве подложки или открой проект с исходным изображением.');
    return;
  }
  if (state.traceBusy) return;
  if (!state.traceLastPoint) {
    const attachment = nearestPipeProjection(point);
    const anchor = attachment ? { x: attachment.point.x, y: attachment.point.y } : point;
    state.traceLastPoint = anchor;
    state.traceWaypoints = [anchor];
    state.traceAttachments = [attachment];
    state.traceSegmentStartIndices = [];
    state.draft = [{ x: anchor.x, y: anchor.y }];
    state.draftStart = attachment;
    state.draftEnd = attachment;
    updateToolButtons(); renderCanvas();
    toast(attachment
      ? 'Начало привязано к существующей подтверждённой трубе. Укажи конец участка или следующий поворот.'
      : 'Начало выбрано. Поставь следующую точку на этой же трубе; на поворотах добавляй промежуточные точки.');
    return;
  }
  const traceStart = mapProjectPointToTrace(state.traceLastPoint);
  const traceEnd = mapProjectPointToTrace(point);
  if (!traceStart || !traceEnd) { toast('Не удалось сопоставить координаты изображения.'); return; }
  state.traceBusy = true;
  updateToolButtons();
  toast('Ищу путь по пикселям ручки в ограниченном коридоре…');
  await new Promise(resolve => requestAnimationFrame(() => resolve()));
  const corridorPx = Math.max(18, Math.min(72, safeNum($('traceCorridor')?.value, 38)));
  let result;
  try {
    result = traceInkRoute({ prepared: state.traceRaster.prepared, start: traceStart, end: traceEnd, corridorPx, maxVisited: 220000 });
  } catch (error) {
    state.traceBusy = false;
    updateToolButtons();
    toast(`Автотрасса остановлена: ${String(error?.message || error).slice(0, 180)}`);
    return;
  }
  state.traceBusy = false;
  if (!result.ok) {
    updateToolButtons();
    toast(result.reason || 'Не удалось проследить участок. Добавь промежуточную точку на линии.');
    return;
  }
  const mapped = result.points.map(mapTracePointToProject).filter(Boolean);
  const attachment = nearestPipeProjection(point);
  const snapLimit = Math.max(8, safeNum($('snapRadius')?.value, 14));
  // Snap only when the traced pixel endpoint itself is close to an existing
  // confirmed route; a nearby click alone is not enough to create a junction.
  const tracedEnd = mapped.at(-1);
  const snappedAttachment = attachment && tracedEnd && distance(tracedEnd, attachment.point) <= snapLimit
    ? attachment : null;
  if (snappedAttachment && mapped.length) mapped[mapped.length - 1] = snappedAttachment.point;
  state.traceSegmentStartIndices.push(state.draft.length);
  for (const next of mapped) {
    const previous = state.draft.at(-1);
    if (!previous || distance(previous, next) > 1.4) state.draft.push(next);
  }
  const nextAnchor = snappedAttachment ? { x: snappedAttachment.point.x, y: snappedAttachment.point.y } : point;
  state.traceLastPoint = nextAnchor;
  state.traceWaypoints.push(nextAnchor);
  state.traceSegments += 1;
  state.traceMetrics.push({ ...result.metrics, snappedToPipe: Boolean(snappedAttachment) });
  state.traceAttachments.push(snappedAttachment);
  state.draftEnd = snappedAttachment;
  updateToolButtons(); renderCanvas();
  toast(`Участок найден: ${Math.round(result.metrics.lengthPx)} px по чернилам, подтверждение ${Math.round(result.metrics.inkSupport * 100)}%. Добавь следующий поворот или примени маршрут.`);
}

function pushUndo() {
  if (!state.project) return;
  state.undo.push(clone({ project: state.project, selected: state.selected, activeVertex: state.activeVertex }));
  if (state.undo.length > 80) state.undo.shift();
  state.redo = [];
  updateHistoryButtons();
}
function updateHistoryButtons() {
  $('undoBtn').disabled = state.undo.length === 0;
  $('redoBtn').disabled = state.redo.length === 0;
}
function undo() {
  if (!state.undo.length || !state.project) return;
  state.redo.push(clone({ project: state.project, selected: state.selected, activeVertex: state.activeVertex }));
  const previous = state.undo.pop(); state.project = previous.project; state.selected = previous.selected; state.activeVertex = previous.activeVertex || null;
  clearDraft(); syncControls(); renderAll(); scheduleSave(); updateHistoryButtons();
}
function redo() {
  if (!state.redo.length || !state.project) return;
  state.undo.push(clone({ project: state.project, selected: state.selected, activeVertex: state.activeVertex }));
  const next = state.redo.pop(); state.project = next.project; state.selected = next.selected; state.activeVertex = next.activeVertex || null;
  clearDraft(); syncControls(); renderAll(); scheduleSave(); updateHistoryButtons();
}
function scheduleSave() {
  if (!state.project) return;
  setSaveState('Есть изменения…', 'dirty');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveProject, 550);
}
async function saveProject() {
  if (!state.project) return;
  clearTimeout(state.saveTimer);
  const snapshot = clone(state.project);
  setSaveState('Сохраняю…', 'busy');
  state.saveChain = state.saveChain.then(async () => {
    const data = await api(`/api/manual-cad/projects/${encodeURIComponent(snapshot.id)}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ project: snapshot })
    });
    if (state.project?.id === snapshot.id) {
      state.project.updatedAt = data.project.updatedAt;
      const latestTitle = state.project.title;
      if (latestTitle === snapshot.title) setSaveState('Сохранено', 'saved');
      else setSaveState('Есть новые изменения…', 'dirty');
    }
    const item=state.projects.find(entry=>entry.id===snapshot.id);
    if(item){item.title=snapshot.title;item.updatedAt=data.project.updatedAt;item.pipeCount=snapshot.pipes.filter(pipe=>pipe.reviewOnly!==true).length;renderProjectList();}
  }).catch(error => { setSaveState('Ошибка сохранения', 'error'); toast(error.message); });
  return state.saveChain;
}

function syncControls() {
  const p = state.project; if (!p) return;
  $('projectTitle').value = p.title || '';
  const backToScheme = $('mcBackToSchemeLink');
  if (backToScheme) {
    backToScheme.href = p.sourceJobId ? `/?job=${encodeURIComponent(p.sourceJobId)}` : '/';
    backToScheme.textContent = p.sourceJobId ? '← Вернуться к схеме дома' : '← Схемы домов';
  }
  $('pageOrientation').value = p.page || 'portrait';
  $('paperSize').value = p.paperSize || 'A4';
  $('drawingStyle').value = p.drawingStyle || 'standard';
  $('preparedBy').value = p.preparedBy || '';
  $('drawingNotes').value = p.notes || '';
  $('siteAddress').value = p.siteAddress || '';
  $('entrance').value = p.entrance || '';
  $('inspectionTitle').value = p.inspectionTitle || '';
  $('schemeSubtitle').value = p.schemeSubtitle || '';
  $('schemeAuthor').value = p.schemeAuthor || '';
  $('schemeChecker').value = p.schemeChecker || '';
  $('riserGroups').value = (p.riserGroups || []).map(group => `${group.name}: ${(group.apartments || []).join(', ')}`).join('\n');
  $('canvasDimensions').textContent = `${p.width} × ${p.height} px`;
  $('orthoMode').checked = state.ortho;
  const hasSource = Boolean(p.sourceUrl);
  $('toggleSourceBtn').disabled = !hasSource;
  $('sourceVisible').disabled = !hasSource;
  $('sourceOpacity').disabled = !hasSource;
  $('sourceVisible').checked = state.sourceVisible;
  $('toggleSourceBtn').textContent = state.sourceVisible ? 'Скрыть подложку' : 'Показать подложку';
  const reviewCount = p.pipes.filter(pipe => pipe.reviewOnly === true).length;
  $('reviewCandidatesLabel').hidden = reviewCount === 0;
  $('showReviewCandidates').checked = state.showReviewCandidates;
  $('reviewCandidatesCount').textContent = String(reviewCount);
  const unknownSymbols = p.symbols.filter(symbol => symbol.type === 'unknown' || symbol.reviewOnly).length;
  const assistPanel = $('mcSketchAssistPanel');
  if (assistPanel) assistPanel.hidden = !p.sourceUrl;
  const assistStats = $('mcSketchCandidateStats');
  if (assistStats) assistStats.textContent = `${reviewCount} маршрутов-кандидатов · ${unknownSymbols} знаков для классификации · автотрасса по ручке: ${state.traceRaster ? 'готова' : 'недоступна'}`;
  const assistButton = $('mcShowSketchCandidatesBtn');
  if (assistButton) { assistButton.disabled = reviewCount === 0; assistButton.textContent = state.showReviewCandidates ? 'Скрыть кандидаты' : 'Показать кандидаты'; }
  $('exportSvgBtn').href = `/api/manual-cad/projects/${p.id}/export.svg`;
  $('exportDxfBtn').href = `/api/manual-cad/projects/${p.id}/export.dxf`;
  $('exportSvgBtn').setAttribute('aria-disabled', 'false'); $('exportDxfBtn').setAttribute('aria-disabled', 'false');
  $('sourceOpacity').value = $('sourceOpacity').value || '58';
  updateHistoryButtons(); updateDeleteButton();
}
function updateToolButtons() {
  document.querySelectorAll('[data-tool]').forEach(button => button.classList.toggle('is-active', button.dataset.tool === state.tool));
  svg.className.baseVal = `tool-${state.tool}`;
  $('finishRouteBtn').disabled = state.traceBusy || state.draft.length < 2 || !['pipe','branch','trace'].includes(state.tool) || (state.tool === 'trace' && state.traceSegments < 1);
  $('finishRouteBtn').textContent = state.tool === 'trace' ? (state.traceBusy ? 'Ищу линию…' : 'Применить маршрут ↵') : 'Завершить линию ↵';
  $('draftStatus').textContent = state.tool === 'trace'
    ? (state.traceSegments ? `Автотрасса: ${state.traceSegments} участков · ${state.draft.length} точек · можно добавить поворот или применить` : (state.traceLastPoint ? 'Начало выбрано · укажи конец первого участка' : 'Укажи начало трубы на исходном эскизе'))
    : (state.draft.length ? `Точек в линии: ${state.draft.length} · Enter — завершить` : 'Нет незавершённых линий');
  $('canvasHint').textContent = ({
    select:'Выбор: нажми на трубу или символ. У выбранной трубы можно перетаскивать вершины.',
    pipe:'Труба: кликай по поворотам маршрута. Двойной щелчок или Enter завершает линию.',
    branch:'Ответвление: первая точка должна попасть на существующую трубу — создастся узел Т-образного соединения.',
    trace:'Автотрасса: кликни начало, затем конец каждого прямого участка по штриху. На поворотах ставь промежуточные точки. Backspace отменяет последний участок, Escape очищает маршрут. Применяй только после проверки синего предпросмотра.',
    node:'Узел: щёлкни по существующему отрезку, чтобы вставить вершину. Выбери инструмент «Выбор», чтобы перетащить её.',
    label:'Подпись: введи текст справа от панели инструментов и щёлкни по месту размещения.',
    symbol:'Символ: выбери тип условного обозначения и щёлкни по месту установки.',
    dimension:'Размер: щёлкни две точки, затем будет создана размерная линия.'
  })[state.tool];
}
function updateDeleteButton() { $('deleteBtn').disabled = !state.selected; $('duplicateBtn').disabled = !state.selected; $('deleteBtn').title = state.activeVertex ? 'Удалить выбранную вершину (Del)' : 'Удалить выбранный элемент (Del)'; }
function setTool(tool) {
  if (!['select','pipe','branch','trace','node','label','symbol','dimension'].includes(tool)) return;
  if (state.draft.length && tool !== state.tool) clearDraft();
  state.tool = tool;
  for (const selector of ['.mc-prop-route','.mc-prop-trace','.mc-prop-label','.mc-prop-symbol','.mc-prop-dimension']) {
    document.querySelectorAll(selector).forEach(el => el.hidden = true);
  }
  if (tool === 'pipe' || tool === 'branch' || tool === 'trace') document.querySelectorAll('.mc-prop-route').forEach(el => el.hidden = false);
  if (tool === 'trace') document.querySelectorAll('.mc-prop-trace').forEach(el => el.hidden = false);
  if (tool === 'label') document.querySelectorAll('.mc-prop-label').forEach(el => el.hidden = false);
  if (tool === 'symbol') document.querySelectorAll('.mc-prop-symbol').forEach(el => el.hidden = false);
  if (tool === 'dimension') document.querySelectorAll('.mc-prop-dimension').forEach(el => el.hidden = false);
  updateToolButtons(); renderCanvas();
}
function clearDraft() { state.draft = []; state.draftStart = null; state.draftEnd = null; state.dimensionStart = null; state.traceLastPoint = null; state.traceSegments = 0; state.traceMetrics = []; state.traceSegmentStartIndices = []; state.traceWaypoints = []; state.traceAttachments = []; state.traceBusy = false; updateToolButtons(); }

function getCanvasPoint(event) {
  const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) return {x:0,y:0};
  const p = point.matrixTransform(matrix.inverse());
  const project = state.project;
  return { x: Math.max(0, Math.min(project.width, p.x)), y: Math.max(0, Math.min(project.height, p.y)) };
}
function distance(a,b) { return Math.hypot(a.x-b.x, a.y-b.y); }
function nearestPipeProjection(point, { includeReview = false } = {}) {
  const limit = safeNum($('snapRadius').value, 14);
  if (limit <= 0) return null;
  let best = null;
  for (const pipe of state.project.pipes) {
    if (pipe.visible === false || (pipe.reviewOnly === true && !includeReview)) continue;
    for (let i=1;i<pipe.points.length;i++) {
      const a={x:pipe.points[i-1][0],y:pipe.points[i-1][1]}, b={x:pipe.points[i][0],y:pipe.points[i][1]};
      const dx=b.x-a.x, dy=b.y-a.y, length2=dx*dx+dy*dy;
      if (length2 < 1e-8) continue;
      const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length2));
      const p={x:a.x+t*dx,y:a.y+t*dy}; const d=distance(point,p);
      if (d <= limit && (!best || d < best.distance)) best={pipeId:pipe.id,segment:i-1,point:p,distance:d};
    }
  }
  return best;
}
function commitJunction(attachment, newPipeId) {
  if (!attachment) return null;
  const parent = state.project.pipes.find(pipe => pipe.id === attachment.pipeId);
  if (!parent) return null;
  const x=attachment.point.x, y=attachment.point.y;
  let junction = state.project.junctions.find(item => Math.hypot(item.x-x,item.y-y) <= 2 && item.pipeIds.includes(parent.id));
  if (!junction) {
    junction={id:uid('j'),x,y,pipeIds:[parent.id]};
    state.project.junctions.push(junction);
  }
  if (!junction.pipeIds.includes(newPipeId)) junction.pipeIds.push(newPipeId);
  let existingIndex=parent.points.findIndex(p=>Math.hypot(p[0]-x,p[1]-y)<=1.5);
  if (existingIndex<0) {
    let nearestIndex = 1, nearestDistance = Infinity;
    for (let i=1;i<parent.points.length;i++) {
      const a={x:parent.points[i-1][0],y:parent.points[i-1][1]}, b={x:parent.points[i][0],y:parent.points[i][1]};
      const dx=b.x-a.x, dy=b.y-a.y, len2=dx*dx+dy*dy;
      const t=len2>0?Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/len2)):0;
      const d=Math.hypot(x-(a.x+t*dx),y-(a.y+t*dy));
      if(d<nearestDistance){nearestDistance=d;nearestIndex=i;}
    }
    parent.points.splice(nearestIndex,0,[x,y]);
  }
  return junction.id;
}
function addPipePoint(point, isStart=false) {
  const attachment = nearestPipeProjection(point);
  if (isStart && state.tool === 'branch' && !attachment) {
    toast('Для ответвления начни линию рядом с существующей трубой. Увеличь радиус привязки, если нужно.'); return;
  }
  let actual = attachment ? {x:attachment.point.x,y:attachment.point.y} : {x:point.x,y:point.y};
  if (state.ortho && state.draft.length) {
    const previous = state.draft[state.draft.length - 1];
    const dx = Math.abs(actual.x - previous.x), dy = Math.abs(actual.y - previous.y);
    actual = dx >= dy ? { x: actual.x, y: previous.y } : { x: previous.x, y: actual.y };
  }
  if (state.draft.length && distance(actual,state.draft[state.draft.length-1]) < 1.5) return;
  state.draft.push(actual);
  if (isStart) state.draftStart = attachment;
  state.draftEnd = attachment;
  renderCanvas(); updateToolButtons();
}
function insertVertexAt(point) {
  const attachment = nearestPipeProjection(point);
  if (!attachment) { toast('Щёлкни ближе к отрезку трубы или увеличь радиус привязки.'); return; }
  const pipe = state.project.pipes.find(item => item.id === attachment.pipeId);
  if (!pipe) return;
  const segmentIndex = attachment.segment;
  const a = pipe.points[segmentIndex], b = pipe.points[segmentIndex + 1];
  if (!a || !b || distance({x:a[0],y:a[1]}, attachment.point) < 3 || distance({x:b[0],y:b[1]}, attachment.point) < 3) {
    toast('В этой точке уже есть вершина. Выбери середину сегмента.'); return;
  }
  pushUndo();
  const index = segmentIndex + 1;
  pipe.points.splice(index, 0, [attachment.point.x, attachment.point.y]);
  state.selected = { type: 'pipe', id: pipe.id };
  state.activeVertex = { pipeId: pipe.id, index };
  setTool('select');
  renderAll();
  scheduleSave();
  toast('Вершина добавлена. Перетащи маркер, чтобы изменить форму трассы.');
}

function removeSelectedVertex() {
  if (!state.activeVertex || state.selected?.type !== 'pipe') return false;
  const pipe = state.project.pipes.find(item => item.id === state.activeVertex.pipeId);
  if (!pipe) { state.activeVertex = null; return false; }
  const index = state.activeVertex.index;
  const pair = pipe.points[index];
  if (!pair) { state.activeVertex = null; return false; }
  const junction = state.project.junctions.find(item => Math.hypot(item.x - pair[0], item.y - pair[1]) <= 2 && item.pipeIds?.length > 1);
  if (junction) {
    toast('Это узел соединения нескольких труб. Сначала перестрой или отсоедини ответвление, чтобы не потерять топологию.');
    return true;
  }
  if (pipe.points.length <= 2) {
    toast('У линии только две опорные точки. Чтобы удалить всю трубу, выбери её линию и нажми ⌫.');
    state.activeVertex = null;
    renderCanvas();
  } else {
    pushUndo();
    pipe.points.splice(index, 1);
    state.activeVertex = null;
    renderAll();
    scheduleSave();
    toast('Вершина удалена. Трубопровод сохранён.');
  }
  return true;
}

function deletePipeById(id) {
  state.project.pipes = state.project.pipes.filter(item => item.id !== id);
  state.project.junctions = state.project.junctions.map(item => ({ ...item, pipeIds: item.pipeIds.filter(pipeId => pipeId !== id) })).filter(item => item.pipeIds.length >= 2);
  state.selected = null;
  state.activeVertex = null;
  renderAll();
  scheduleSave();
}

function finishRoute() {
  if (state.draft.length < 2) { toast('Для трубы нужно хотя бы две точки.'); return; }
  pushUndo();
  const id=uid('pipe');
  const name=$('pipeName').value.trim(); const diameter=$('pipeDiameter').value.trim();
  const startAttachment=state.draftStart;
  // Resolve all explicit snaps before inserting the new pipe, so the route
  // cannot attach to itself. Intermediate waypoints may form real junctions.
  const endAttachment=state.draftEnd || nearestPipeProjection(state.draft[state.draft.length-1]);
  const routePoints=state.draft.map(p=>[p.x,p.y]);
  if (startAttachment && routePoints.length) routePoints[0]=[startAttachment.point.x,startAttachment.point.y];
  if (endAttachment && routePoints.length) routePoints[routePoints.length-1]=[endAttachment.point.x,endAttachment.point.y];
  const pipe={id,name,diameter,kind:state.tool==='branch'?'branch':$('pipeKind').value==='riser'?'riser':'pipe',points:routePoints,visible:true};
  if (state.tool === 'trace') {
    pipe.source = 'ink-trace-assist';
    pipe.traceMetrics = clone(state.traceMetrics);
    pipe.reviewOnly = false; // operator explicitly reviewed and applied the preview.
    pipe.reviewReason = '';
  }
  state.project.pipes.push(pipe);
  const seenAttachments = new Set();
  for (const attachment of [startAttachment, ...state.traceAttachments, endAttachment].filter(Boolean)) {
    const key = `${attachment.pipeId}:${Math.round(attachment.point.x * 2)}:${Math.round(attachment.point.y * 2)}`;
    if (seenAttachments.has(key)) continue;
    seenAttachments.add(key);
    commitJunction(attachment,id);
  }
  state.selected={type:'pipe',id}; const wasTrace = pipe.source === 'ink-trace-assist'; clearDraft(); renderAll(); scheduleSave(); toast(wasTrace ? 'Маршрут по чернилам добавлен. Проверь узлы и направление по исходнику.' : 'Трубопровод добавлен. Узлы привязки отмечены явно.');
}
function handleCanvasClick(event) {
  if (!state.project) return;
  if (state.justDragged) { state.justDragged = false; return; }
  const point=getCanvasPoint(event);
  $('cursorPosition').textContent=`X: ${Math.round(point.x)} · Y: ${Math.round(point.y)}`;
  if (state.tool === 'node') { insertVertexAt(point); return; }
  if (state.tool === 'trace') { if (event.detail > 1) return; void addInkTraceWaypoint(point); return; }
  if (state.tool==='pipe' || state.tool==='branch') {
    if (event.detail >= 2) { finishRoute(); return; }
    addPipePoint(point,state.draft.length===0); return;
  }
  if (state.tool==='label') {
    const value=$('labelText').value.trim();
    if (!value) { toast('Сначала введи текст подписи.'); return; }
    pushUndo(); const item={id:uid('label'),text:value,x:point.x,y:point.y,size:18,rotation:0,anchor:'start'};
    state.project.labels.push(item); state.selected={type:'label',id:item.id}; renderAll(); scheduleSave(); return;
  }
  if (state.tool==='symbol') {
    pushUndo(); const item={id:uid('sym'),type:$('symbolType').value,x:point.x,y:point.y,rotation:0,label:'',scale:1};
    state.project.symbols.push(item); state.selected={type:'symbol',id:item.id}; renderAll(); scheduleSave(); return;
  }
  if (state.tool==='dimension') {
    if (!state.dimensionStart) { state.dimensionStart=[point.x,point.y]; renderCanvas(); toast('Теперь выбери вторую точку размера.'); return; }
    const value=$('dimensionText').value.trim();
    if (!value) { toast('Введи значение размера в панели инструментов.'); return; }
    if (distance({x:state.dimensionStart[0],y:state.dimensionStart[1]},point)<2) { toast('Точки размера должны быть разнесены.'); return; }
    pushUndo(); state.project.dimensions.push({id:uid('dim'),a:state.dimensionStart,b:[point.x,point.y],text:value});
    state.dimensionStart=null; renderAll(); scheduleSave(); return;
  }
  const hit=event.target.closest('[data-element-type][data-element-id]');
  if (hit) {
    state.selected={type:hit.dataset.elementType,id:hit.dataset.elementId};
    state.activeVertex=null;
  } else { state.selected=null; state.activeVertex=null; }
  renderAll();
}

function symbolSvg(symbol) {
  const x=safeNum(symbol.x), y=safeNum(symbol.y), s=18*safeNum(symbol.scale,1), rotate=safeNum(symbol.rotation);
  let shape='';
  if (symbol.type==='valve') shape=`<path d="M ${-s} ${-s} L 0 0 L ${-s} ${s} Z M ${s} ${-s} L 0 0 L ${s} ${s} Z"/><path d="M 0 ${-s} V ${-s*1.6}"/>`;
  if (symbol.type==='meter') shape=`<circle r="${s*1.1}"/><text x="0" y="5" text-anchor="middle">G</text>`;
  if (symbol.type==='regulator') shape=`<rect x="${-s*1.3}" y="${-s*.8}" width="${s*2.6}" height="${s*1.6}"/><path d="M ${-s} ${s*.55} L ${s} ${-s*.55}"/>`;
  if (symbol.type==='consumer') shape=`<circle r="${s*1.15}"/><path d="M 0 ${s*.8} C ${-s*1.2} 0 ${s*.5} ${-s*.2} 0 ${-s*.8} C ${s*1.2} 0 ${s*.5} ${s*.4} 0 ${s*.8}"/>`;
  if (symbol.type==='riser') shape=`<path d="M 0 ${s*1.5} V ${-s*1.5} M ${-s*.8} ${-s*1.5} H ${s*.8}"/>`;
  if (symbol.type==='filter') shape=`<rect x="${-s}" y="${-s*.85}" width="${s*2}" height="${s*1.7}"/><path d="M ${-s*.7} ${s*.65} L ${s*.7} ${-s*.65}"/>`;
  if (symbol.type==='unknown') shape=`<circle r="${s*1.2}" fill="#fff7ed" stroke="#d97706" stroke-dasharray="4 3"/><text x="0" y="5" text-anchor="middle" fill="#b45309" stroke="none">?</text>`;
  if (symbol.type==='callout') shape=`<rect x="${-s*1.45}" y="${-s}" width="${s*2.9}" height="${s*2}"/><text x="0" y="${s*.38}" text-anchor="middle">${esc(symbol.label||'')}</text>`;
  const caption=symbol.label&&symbol.type!=='callout'?`<text x="0" y="${s*1.8}" text-anchor="middle">${esc(symbol.label)}</text>`:'';
  return `<g class="mc-cad-symbol ${symbol.reviewOnly?'mc-symbol-review':''} ${state.selected?.type==='symbol'&&state.selected.id===symbol.id?'is-selected':''}" data-element-type="symbol" data-element-id="${esc(symbol.id)}" transform="translate(${x} ${y}) rotate(${rotate})">${shape}${caption}</g>`;
}
function renderCanvas() {
  const p=state.project; if (!p) return;
  svg.setAttribute('viewBox',`0 0 ${p.width} ${p.height}`);
  const source = p.sourceUrl && state.sourceVisible ? `<image class="mc-source-image" href="${esc(p.sourceUrl)}?v=${encodeURIComponent(p.source?.uploadedAt||'1')}" x="0" y="0" width="${p.width}" height="${p.height}" preserveAspectRatio="none" opacity="${safeNum($('sourceOpacity').value,58)/100}"/>` : '';
  const grid = p.sourceUrl ? '' : `<rect width="${p.width}" height="${p.height}" fill="url(#mcGrid)"/>`;
  const pipes=p.pipes.map(pipe=>{
    if(pipe.visible===false)return '';
    const points=pipe.points.map(pair=>`${safeNum(pair[0])},${safeNum(pair[1])}`).join(' ');
    const selected=state.selected?.type==='pipe'&&state.selected.id===pipe.id;
    const reviewClass = pipe.reviewOnly === true ? 'mc-pipe-review' : '';
    return `<g data-element-type="pipe" data-element-id="${esc(pipe.id)}"><polyline class="mc-pipe-hit" points="${points}"/><polyline class="mc-pipe mc-pipe-${esc(pipe.kind||'pipe')} ${reviewClass} ${selected?'is-selected':''}" points="${points}"/>${selected?pipe.points.map((pair,index)=>`<circle class="mc-vertex ${state.activeVertex?.pipeId===pipe.id&&state.activeVertex.index===index?'is-active':''}" data-vertex-pipe="${esc(pipe.id)}" data-vertex-index="${index}" cx="${pair[0]}" cy="${pair[1]}" r="${state.activeVertex?.pipeId===pipe.id&&state.activeVertex.index===index?10:7}"/>`).join(''):''}</g>`;
  }).join('');
  const junctions=p.junctions.map(j=>`<circle class="mc-junction" cx="${j.x}" cy="${j.y}" r="5"><title>Соединение: ${j.pipeIds.length} участка</title></circle>`).join('');
  const symbols=p.symbols.map(symbolSvg).join('');
  const labels=p.labels.map(item=>`<text class="mc-cad-label ${state.selected?.type==='label'&&state.selected.id===item.id?'is-selected':''}" data-element-type="label" data-element-id="${esc(item.id)}" x="${item.x}" y="${item.y}" font-size="${item.size}" text-anchor="${item.anchor||'start'}" transform="rotate(${item.rotation||0} ${item.x} ${item.y})">${esc(item.text)}</text>`).join('');
  const dimensions=p.dimensions.map(item=>`<g data-element-type="dimension" data-element-id="${esc(item.id)}"><path class="mc-dimension" d="M ${item.a[0]} ${item.a[1]} L ${item.b[0]} ${item.b[1]} M ${item.a[0]-5} ${item.a[1]-5} l 10 10 M ${item.b[0]-5} ${item.b[1]-5} l 10 10"/><text class="mc-dimension-text" x="${(item.a[0]+item.b[0])/2}" y="${(item.a[1]+item.b[1])/2-8}" text-anchor="middle">${esc(item.text)}</text></g>`).join('');
  let draft='';
  if(state.draft.length){const points=state.draft.map(pt=>`${pt.x},${pt.y}`).join(' ');const traceClass=state.tool==='trace'?'mc-draft-trace':'';draft=`<polyline class="mc-draft ${traceClass}" points="${points}"/>${state.draft.map((pt,index)=>`<circle class="mc-snap-ring ${state.tool==='trace'?'mc-trace-waypoint':''}" cx="${pt.x}" cy="${pt.y}" r="${index===0||index===state.draft.length-1?8:5}"/>`).join('')}`;}
  if(state.dimensionStart) draft+=`<circle class="mc-snap-ring" cx="${state.dimensionStart[0]}" cy="${state.dimensionStart[1]}" r="7"/>`;
  svg.innerHTML=`<defs><pattern id="mcGrid" width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" fill="none" stroke="#dce4de" stroke-width="1"/></pattern></defs><rect width="${p.width}" height="${p.height}" fill="#fff"/>${grid}${source}${pipes}${junctions}${dimensions}${symbols}${labels}${draft}`;
  svg.className.baseVal=`tool-${state.tool}`;
  updateZoom(state.zoom);
  updateToolButtons(); updateStatistics(); renderProperties();
}
function updateStatistics() {
  const p=state.project;
  const primaryCount=p.pipes.filter(pipe=>pipe.reviewOnly!==true).length;
  const reviewCount=p.pipes.filter(pipe=>pipe.reviewOnly===true).length;
  $('drawingStats').innerHTML=`<div><span>Основные трубы</span><b>${primaryCount}</b></div><div><span>На проверку</span><b>${reviewCount}</b></div><div><span>Узлы</span><b>${p.junctions.length}</b></div><div><span>Символы</span><b>${p.symbols.length}</b></div><div><span>Подписи / размеры</span><b>${p.labels.length+p.dimensions.length}</b></div>`;
}
function selectedItem() {
  if(!state.selected||!state.project)return null;
  const table={pipe:'pipes',symbol:'symbols',label:'labels',dimension:'dimensions'};
  const collection=state.project[table[state.selected.type]];
  return collection?.find(item=>item.id===state.selected.id)||null;
}
function renderProperties() {
  const item=selectedItem();
  $('selectionEmpty').hidden=Boolean(item); $('selectionProperties').hidden=!item;
  $('selectionType').textContent=item?({pipe:'ТРУБА',symbol:'СИМВОЛ',label:'ПОДПИСЬ',dimension:'РАЗМЕР'}[state.selected.type]||'ЭЛЕМЕНТ'):'—';
  if(!item){updateDeleteButton();return;}
  $('selectedName').value=item.name??item.text??item.label??item.type??'';
  $('selectedDiameter').value=item.diameter||'';
  $('selectedDiameterWrap').hidden=state.selected.type!=='pipe';
  $('selectedKindWrap').hidden=state.selected.type!=='pipe';
  if (state.selected.type==='pipe') $('selectedKind').value=item.kind||'pipe';
  $('selectedSymbolWrap').hidden=state.selected.type!=='symbol';
  $('selectedSymbolLabel').value=item.label||'';
  if (state.selected.type==='symbol') $('selectedSymbolType').value=item.type||'valve';
  const isPointElement=['symbol','label'].includes(state.selected.type);
  $('selectedPositionWrap').hidden=!isPointElement;
  $('selectedTransformWrap').hidden=!isPointElement;
  if (isPointElement) { $('selectedX').value=Math.round(safeNum(item.x)); $('selectedY').value=Math.round(safeNum(item.y)); $('selectedRotation').value=Math.round(safeNum(item.rotation)); }
  $('selectedScaleWrap').hidden=state.selected.type!=='symbol';
  $('selectedFontSizeWrap').hidden=state.selected.type!=='label';
  if (state.selected.type==='symbol') $('selectedScale').value=safeNum(item.scale,1);
  if (state.selected.type==='label') $('selectedFontSize').value=safeNum(item.size,18);
  $('selectedHelp').textContent=state.selected.type==='pipe'?(item.reviewOnly ? (item.reviewReason || 'Кандидат не включён в чистовой экспорт. Сверь его с исходной фотографией.') : 'Перетаскивай круглые маркеры для правки вершин; «Узел» вставляет новую вершину; перетаскивание линии двигает всю ветку с сохранением стыков.') : state.selected.type==='symbol' && item.reviewOnly ? (item.reviewReason || 'Знак распознан, но не классифицирован. Выбери его точный тип по исходному эскизу.') : 'Перетаскивай элемент на листе или измени координаты, поворот и масштаб в свойствах.';
  $('acceptReviewPipeBtn').hidden=!(state.selected.type==='pipe' && item.reviewOnly===true);
  updateDeleteButton();
}
function renderAll(){syncControls();renderCanvas();renderProjectList();}

function duplicateSelected() {
  const item=selectedItem();
  if(!item||!state.project)return;
  pushUndo();
  const copy=clone(item);
  copy.id=uid(state.selected.type);
  if(state.selected.type==='pipe') {
    copy.points=copy.points.map(([x,y])=>[Math.min(state.project.width,x+24),Math.min(state.project.height,y+24)]);
    state.project.pipes.push(copy);
  } else if(state.selected.type==='symbol'||state.selected.type==='label') {
    copy.x=Math.min(state.project.width,copy.x+24); copy.y=Math.min(state.project.height,copy.y+24);
    state.project[state.selected.type==='symbol'?'symbols':'labels'].push(copy);
  } else {
    copy.a=[Math.min(state.project.width,copy.a[0]+24),Math.min(state.project.height,copy.a[1]+24)];
    copy.b=[Math.min(state.project.width,copy.b[0]+24),Math.min(state.project.height,copy.b[1]+24)];
    state.project.dimensions.push(copy);
  }
  state.selected={type:state.selected.type,id:copy.id};
  state.activeVertex=null; renderAll(); scheduleSave();
  toast('Копия создана со смещением 24 px. Её можно переместить отдельно.');
}

function deleteSelected() {
  if(!state.selected||!state.project)return;
  if (removeSelectedVertex()) return;
  const {type,id}=state.selected;
  pushUndo();
  if(type==='pipe') {
    state.project.pipes=state.project.pipes.filter(item=>item.id!==id);
    state.project.junctions=state.project.junctions
      .map(item=>({...item,pipeIds:(item.pipeIds||[]).filter(pipeId=>pipeId!==id)}))
      .filter(item=>item.pipeIds.length>=2);
  } else if(type==='symbol') state.project.symbols=state.project.symbols.filter(x=>x.id!==id);
  else if(type==='label') state.project.labels=state.project.labels.filter(x=>x.id!==id);
  else if(type==='dimension') state.project.dimensions=state.project.dimensions.filter(x=>x.id!==id);
  state.selected=null; state.activeVertex=null; renderAll(); scheduleSave();
}


function startDrag(event) {
  if(state.tool!=='select'||!state.project)return;
  const vertex=event.target.closest('[data-vertex-pipe][data-vertex-index]');
  const item=event.target.closest('[data-element-type][data-element-id]');
  if(vertex){
    state.selected={type:'pipe',id:vertex.dataset.vertexPipe};
    const pipe=state.project.pipes.find(x=>x.id===state.selected.id); if(!pipe)return;
    const index=Number(vertex.dataset.vertexIndex);
    state.activeVertex={pipeId:pipe.id,index};
    const coordinate=pipe.points[index];
    const junction=state.project.junctions.find(j=>Math.hypot(j.x-coordinate[0],j.y-coordinate[1])<=2);
    pushUndo(); state.drag=junction?{type:'junction',id:junction.id}:{type:'vertex',id:pipe.id,index};
    svg.setPointerCapture?.(event.pointerId); event.preventDefault(); renderCanvas(); return;
  }
  if(item?.dataset.elementType==='pipe'){
    const pipe=state.project.pipes.find(x=>x.id===item.dataset.elementId); if(!pipe)return;
    state.selected={type:'pipe',id:pipe.id}; state.activeVertex=null;
    const origin=getCanvasPoint(event);
    const attachedJunctions=state.project.junctions.filter(j=>j.pipeIds?.includes(pipe.id)).map(j=>({
      id:j.id, x:j.x, y:j.y,
      neighbors:(j.pipeIds||[]).filter(id=>id!==pipe.id).map(id=>({
        id, indexes:(state.project.pipes.find(candidate=>candidate.id===id)?.points||[])
          .map((pair,index)=>Math.hypot(pair[0]-j.x,pair[1]-j.y)<=3?index:-1).filter(index=>index>=0)
      }))
    }));
    pushUndo();
    state.drag={type:'pipe',id:pipe.id,origin,startPoints:clone(pipe.points),attachedJunctions};
    svg.setPointerCapture?.(event.pointerId); event.preventDefault(); renderCanvas(); return;
  }
  if(item&&['symbol','label','dimension'].includes(item.dataset.elementType)){
    state.selected={type:item.dataset.elementType,id:item.dataset.elementId}; state.activeVertex=null;
    const value=selectedItem(); if(!value)return;
    const point=getCanvasPoint(event); pushUndo();
    state.drag={type:item.dataset.elementType,id:value.id,origin:point,start:{x:value.x,y:value.y},startA:value.a?clone(value.a):null,startB:value.b?clone(value.b):null};
    svg.setPointerCapture?.(event.pointerId); event.preventDefault(); renderCanvas();
  }
}
function moveDrag(event) {
  if(!state.drag||!state.project)return;
  const pt=getCanvasPoint(event), drag=state.drag;
  if(drag.type==='vertex'){
    const pipe=state.project.pipes.find(x=>x.id===drag.id); if(pipe?.points[drag.index])pipe.points[drag.index]=[pt.x,pt.y];
  } else if(drag.type==='junction') {
    const junction=state.project.junctions.find(x=>x.id===drag.id);
    if(junction){
      const ox=junction.x, oy=junction.y; junction.x=pt.x; junction.y=pt.y;
      for(const pipeId of junction.pipeIds){
        const pipe=state.project.pipes.find(x=>x.id===pipeId); if(!pipe)continue;
        let nearest=-1,best=Infinity;
        pipe.points.forEach((pair,index)=>{const d=Math.hypot(pair[0]-ox,pair[1]-oy);if(d<best){best=d;nearest=index;}});
        if(nearest>=0&&best<=3)pipe.points[nearest]=[pt.x,pt.y];
      }
    }
  } else if(drag.type==='pipe') {
    const pipe=state.project.pipes.find(x=>x.id===drag.id); if(!pipe)return;
    const dx=pt.x-drag.origin.x, dy=pt.y-drag.origin.y;
    pipe.points=drag.startPoints.map(pair=>[pair[0]+dx,pair[1]+dy]);
    for(const linked of drag.attachedJunctions||[]){
      const junction=state.project.junctions.find(x=>x.id===linked.id); if(!junction)continue;
      junction.x=linked.x+dx; junction.y=linked.y+dy;
      for(const neighbor of linked.neighbors){
        const other=state.project.pipes.find(x=>x.id===neighbor.id); if(!other)continue;
        for(const index of neighbor.indexes){ if(other.points[index])other.points[index]=[linked.x+dx,linked.y+dy]; }
      }
    }
  } else {
    const collection=drag.type==='symbol'?'symbols':drag.type==='label'?'labels':'dimensions'; const item=state.project[collection].find(x=>x.id===drag.id);
    if(item){
      const dx=pt.x-drag.origin.x, dy=pt.y-drag.origin.y;
      if(drag.type==='dimension'){
        item.a=[drag.startA[0]+dx,drag.startA[1]+dy]; item.b=[drag.startB[0]+dx,drag.startB[1]+dy];
      } else {
        item.x=Math.max(0,Math.min(state.project.width,drag.start.x+dx));
        item.y=Math.max(0,Math.min(state.project.height,drag.start.y+dy));
      }
    }
  }
  renderCanvas();
}
function endDrag(){if(!state.drag)return;state.drag=null;state.justDragged=true;setTimeout(()=>{state.justDragged=false;},0);scheduleSave();renderAll();}

function updateZoom(value) {
  state.zoom=Math.max(0.5,Math.min(2.5,Math.round(value*100)/100));
  svg.style.width=`${Math.round(state.zoom*100)}%`;
  svg.style.height='auto';
  svg.style.maxWidth='none';
  $('zoomResetBtn').textContent=`${Math.round(state.zoom*100)}%`;
  $('zoomResetBtn').setAttribute('aria-label',`Масштаб ${Math.round(state.zoom*100)} процентов; нажми, чтобы сбросить`);
}


async function uploadSource(file) {
  if(!state.project||!file)return;
  if(file.size>18*1024*1024){toast('Файл больше 18 МБ.');return;}
  const image=new Image(); const objectUrl=URL.createObjectURL(file);
  try{
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Не удалось прочитать изображение.'));image.src=objectUrl;});
    const form=new FormData();form.append('source',file);form.append('width',String(image.naturalWidth));form.append('height',String(image.naturalHeight));
    setSaveState('Загружаю подложку…','busy');
    const data=await api(`/api/manual-cad/projects/${state.project.id}/source`,{method:'POST',body:form});
    state.project=ensureProjectDefaults(data.project);state.sourceVisible=true;clearDraft();await loadTraceRaster(state.project);syncControls();renderCanvas();await refreshProjectList();setSaveState('Подложка загружена','saved');
    toast(`Подложка загружена: ${image.naturalWidth} × ${image.naturalHeight}. Автотрасса готова: укажи начало и конец участка.`);
  }catch(error){setSaveState('Ошибка загрузки','error');toast(error.message);}finally{URL.revokeObjectURL(objectUrl);$('sourceFile').value='';}
}

// Toolbar and document settings
$('newProjectBtn').addEventListener('click',()=>createProject(true));
document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>setTool(button.dataset.tool)));
$('finishRouteBtn').addEventListener('click',finishRoute);
$('undoBtn').addEventListener('click',undo);$('redoBtn').addEventListener('click',redo);$('duplicateBtn').addEventListener('click',duplicateSelected);$('deleteBtn').addEventListener('click',deleteSelected);
$('sourceFile').addEventListener('change',event=>uploadSource(event.target.files?.[0]));
$('toggleSourceBtn').addEventListener('click',()=>{state.sourceVisible=!state.sourceVisible;$('sourceVisible').checked=state.sourceVisible;$('toggleSourceBtn').textContent=state.sourceVisible?'Скрыть подложку':'Показать подложку';renderCanvas();});
$('sourceVisible').addEventListener('change',event=>{state.sourceVisible=event.target.checked;$('toggleSourceBtn').textContent=state.sourceVisible?'Скрыть подложку':'Показать подложку';renderCanvas();});
$('sourceOpacity').addEventListener('input',renderCanvas);
$('projectTitle').addEventListener('input',event=>{if(!state.project)return;state.project.title=event.target.value;scheduleSave();});
$('pageOrientation').addEventListener('change',event=>{if(!state.project)return;pushUndo();state.project.page=event.target.value;scheduleSave();});
$('paperSize').addEventListener('change',event=>{if(!state.project)return;pushUndo();state.project.paperSize=event.target.value;scheduleSave();});
$('drawingStyle').addEventListener('change',event=>{if(!state.project)return;pushUndo();state.project.drawingStyle=event.target.value;scheduleSave();toast(event.target.value==='lpgcad-r1'?'Включено оформление LPGCad R1. Геометрия не изменена.':'Включено стандартное оформление CAD.');});
$('preparedBy').addEventListener('input',event=>{if(!state.project)return;state.project.preparedBy=event.target.value;scheduleSave();});
$('drawingNotes').addEventListener('input',event=>{if(!state.project)return;state.project.notes=event.target.value;scheduleSave();});
for (const [id, key] of [['siteAddress','siteAddress'],['entrance','entrance'],['inspectionTitle','inspectionTitle'],['schemeSubtitle','schemeSubtitle'],['schemeAuthor','schemeAuthor'],['schemeChecker','schemeChecker']]) {
  $(id).addEventListener('input',event=>{if(!state.project)return;state.project[key]=event.target.value;scheduleSave();});
}
$('riserGroups').addEventListener('change',event=>{
  if(!state.project)return;
  pushUndo();
  state.project.riserGroups=String(event.target.value||'').split(/\r?\n/).map((line,index)=>{
    const split=line.split(/[:：]/,2);
    if(split.length<2)return null;
    const name=split[0].trim().slice(0,40);
    const apartments=split[1].split(/[,;|]/).map(value=>value.trim().slice(0,24)).filter(Boolean).slice(0,30);
    return name&&apartments.length?{id:`riser_group_${index+1}`,name,apartments}:null;
  }).filter(Boolean).slice(0,8);
  scheduleSave();
  toast(`Групп стояков: ${state.project.riserGroups.length}. Номера квартир перенесены в чистовой лист.`);
});
$('saveNowBtn').addEventListener('click',()=>saveProject());
$('orthoMode').addEventListener('change',event=>{state.ortho=event.target.checked;toast(state.ortho?'Ортогональное построение включено.':'Свободное построение включено.');});
$('zoomInBtn').addEventListener('click',()=>updateZoom(state.zoom+.1));
$('zoomOutBtn').addEventListener('click',()=>updateZoom(state.zoom-.1));
$('zoomResetBtn').addEventListener('click',()=>updateZoom(1));
svg.addEventListener('click',handleCanvasClick);
svg.addEventListener('pointerdown',startDrag);
svg.addEventListener('pointermove',moveDrag);
svg.addEventListener('pointerup',endDrag);
svg.addEventListener('pointercancel',endDrag);
svg.addEventListener('pointermove',event=>{if(!state.project)return;if(!state.drag){const p=getCanvasPoint(event);$('cursorPosition').textContent=`X: ${Math.round(p.x)} · Y: ${Math.round(p.y)}`;}});
svg.addEventListener('dblclick',event=>{if(['pipe','branch'].includes(state.tool)){event.preventDefault();finishRoute();}});
window.addEventListener('keydown',event=>{
  if(event.target.matches('input,textarea,select'))return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();redo();return;}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'){event.preventDefault();duplicateSelected();return;}
  if(event.key==='Escape'){clearDraft();state.activeVertex=null;renderCanvas();return;}
  if(event.key.toLowerCase()==='o'&&!event.ctrlKey&&!event.metaKey){state.ortho=!state.ortho;$('orthoMode').checked=state.ortho;return;}
  if(event.key.toLowerCase()==='n'&&!event.ctrlKey&&!event.metaKey){setTool('node');return;}
  if(event.key==='Enter'&&['pipe','branch','trace'].includes(state.tool)){event.preventDefault();finishRoute();return;}
  if(event.key==='Backspace'&&state.tool==='trace'&&state.traceSegments>0){event.preventDefault();const cut=state.traceSegmentStartIndices.pop()??1;state.draft=state.draft.slice(0,cut);state.traceSegments=Math.max(0,state.traceSegments-1);state.traceMetrics.pop();state.traceWaypoints.pop();state.traceAttachments.pop();state.traceLastPoint=state.traceWaypoints.at(-1)||null;state.draftEnd=state.traceAttachments.at(-1)||null;updateToolButtons();renderCanvas();return;}
  if(event.key==='Backspace'&&state.draft.length){state.draft.pop();if(!state.draft.length)state.draftStart=null;renderCanvas();return;}
  if((event.key==='Delete'||event.key==='Backspace')&&state.selected){event.preventDefault();deleteSelected();}
});

// Edit selected properties without losing text cursor during redraw.
$('selectedName').addEventListener('change',event=>{
  const item=selectedItem();if(!item)return;pushUndo();
  if(state.selected.type==='pipe')item.name=event.target.value;
  else if(state.selected.type==='label')item.text=event.target.value;
  else if(state.selected.type==='symbol')item.label=event.target.value;
  else if(state.selected.type==='dimension')item.text=event.target.value;
  renderCanvas();scheduleSave();
});
$('selectedDiameter').addEventListener('change',event=>{const item=selectedItem();if(!item||state.selected.type!=='pipe')return;pushUndo();item.diameter=event.target.value;renderCanvas();scheduleSave();});
$('selectedSymbolLabel').addEventListener('change',event=>{const item=selectedItem();if(!item||state.selected.type!=='symbol')return;pushUndo();item.label=event.target.value;renderCanvas();scheduleSave();});
$('selectedSymbolType').addEventListener('change',event=>{const item=selectedItem();if(!item||state.selected.type!=='symbol')return;pushUndo();item.type=event.target.value;item.reviewOnly=item.type==='unknown';item.reviewReason=item.reviewOnly?'Знак оставлен неопределённым.':'Оператор классифицировал условный знак; проверь положение и ориентацию.';renderAll();scheduleSave();toast(item.reviewOnly?'Знак оставлен на классификацию.':'Классификация знака сохранена.');});
$('selectedKind').addEventListener('change',event=>{const item=selectedItem();if(!item||state.selected.type!=='pipe')return;pushUndo();item.kind=event.target.value;renderCanvas();scheduleSave();});
for (const [id,key] of [['selectedX','x'],['selectedY','y'],['selectedRotation','rotation'],['selectedScale','scale'],['selectedFontSize','size']]) {
  $(id).addEventListener('change',event=>{const item=selectedItem();if(!item)return;const value=Number(event.target.value);if(!Number.isFinite(value))return;pushUndo();item[key]=key==='scale'?Math.max(.25,Math.min(4,value)):key==='size'?Math.max(6,Math.min(120,value)):key==='rotation'?Math.max(-360,Math.min(360,value)):Math.max(0,Math.min(key==='x'?state.project.width:state.project.height,value));renderCanvas();scheduleSave();});
}
$('showReviewCandidates').addEventListener('change',event=>{state.showReviewCandidates=event.target.checked;renderCanvas();const b=$('mcShowSketchCandidatesBtn');if(b)b.textContent=state.showReviewCandidates?'Скрыть кандидаты':'Показать кандидаты';});
$('mcShowSketchCandidatesBtn')?.addEventListener('click',()=>{state.showReviewCandidates=!state.showReviewCandidates;$('showReviewCandidates').checked=state.showReviewCandidates;renderCanvas();const b=$('mcShowSketchCandidatesBtn');if(b)b.textContent=state.showReviewCandidates?'Скрыть кандидаты':'Показать кандидаты';});
$('acceptReviewPipeBtn').addEventListener('click',()=>{
  const item=selectedItem();
  if(!item||state.selected?.type!=='pipe'||item.reviewOnly!==true)return;
  pushUndo();item.reviewOnly=false;item.reviewReason='';
  state.showReviewCandidates=true;renderAll();scheduleSave();
  toast('Линия подтверждена и включена в чистовой чертёж. Проверь её соединения и назначение.');
});

window.addEventListener('beforeunload',event=>{
  if(state.saveTimer){event.preventDefault();event.returnValue='';}
});
loadProjects(new URLSearchParams(window.location.search).get('project'));
