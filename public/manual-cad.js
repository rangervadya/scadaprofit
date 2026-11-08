'use strict';
const $ = id => document.getElementById(id);
const svg = $('cadCanvas');
const state = {
  projects: [], project: null, tool: 'select', selected: null,
  draft: [], draftStart: null, draftEnd: null, dimensionStart: null,
  sourceVisible: true, showReviewCandidates: false, saveTimer: null, saveChain: Promise.resolve(),
  undo: [], redo: [], drag: null, justDragged: false, lastSaved: null, toastTimer: null
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
  project.pipes.forEach(pipe => { pipe.reviewOnly = pipe.reviewOnly === true; pipe.reviewReason ||= ''; });
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
    state.undo = []; state.redo = []; state.selected = null; clearDraft(); state.showReviewCandidates = false;
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
    state.undo = []; state.redo = []; state.selected = null; clearDraft(); state.sourceVisible = true; state.showReviewCandidates = false;
    syncControls(); renderAll(); setSaveState('Сохранено', 'saved'); await refreshProjectList();
  } catch (error) { toast(error.message); }
}

function pushUndo() {
  if (!state.project) return;
  state.undo.push(clone({ project: state.project, selected: state.selected }));
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
  state.redo.push(clone({ project: state.project, selected: state.selected }));
  const previous = state.undo.pop(); state.project = previous.project; state.selected = previous.selected;
  clearDraft(); syncControls(); renderAll(); scheduleSave(); updateHistoryButtons();
}
function redo() {
  if (!state.redo.length || !state.project) return;
  state.undo.push(clone({ project: state.project, selected: state.selected }));
  const next = state.redo.pop(); state.project = next.project; state.selected = next.selected;
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
  $('exportSvgBtn').href = `/api/manual-cad/projects/${p.id}/export.svg`;
  $('exportDxfBtn').href = `/api/manual-cad/projects/${p.id}/export.dxf`;
  $('exportSvgBtn').setAttribute('aria-disabled', 'false'); $('exportDxfBtn').setAttribute('aria-disabled', 'false');
  $('sourceOpacity').value = $('sourceOpacity').value || '58';
  updateHistoryButtons(); updateDeleteButton();
}
function updateToolButtons() {
  document.querySelectorAll('[data-tool]').forEach(button => button.classList.toggle('is-active', button.dataset.tool === state.tool));
  svg.className.baseVal = `tool-${state.tool}`;
  $('finishRouteBtn').disabled = state.draft.length < 2 || !['pipe','branch'].includes(state.tool);
  $('draftStatus').textContent = state.draft.length ? `Точек в линии: ${state.draft.length} · Enter — завершить` : 'Нет незавершённых линий';
  $('canvasHint').textContent = ({
    select:'Выбор: нажми на трубу или символ. У выбранной трубы можно перетаскивать вершины.',
    pipe:'Труба: кликай по поворотам маршрута. Двойной щелчок или Enter завершает линию.',
    branch:'Ответвление: первая точка должна попасть на существующую трубу — создастся узел Т-образного соединения.',
    label:'Подпись: введи текст справа от панели инструментов и щёлкни по месту размещения.',
    symbol:'Символ: выбери тип условного обозначения и щёлкни по месту установки.',
    dimension:'Размер: щёлкни две точки, затем будет создана размерная линия.'
  })[state.tool];
}
function updateDeleteButton() { $('deleteBtn').disabled = !state.selected; }
function setTool(tool) {
  if (!['select','pipe','branch','label','symbol','dimension'].includes(tool)) return;
  if (state.draft.length && tool !== state.tool) clearDraft();
  state.tool = tool;
  for (const selector of ['.mc-prop-route','.mc-prop-label','.mc-prop-symbol','.mc-prop-dimension']) {
    document.querySelectorAll(selector).forEach(el => el.hidden = true);
  }
  if (tool === 'pipe' || tool === 'branch') document.querySelectorAll('.mc-prop-route').forEach(el => el.hidden = false);
  if (tool === 'label') document.querySelectorAll('.mc-prop-label').forEach(el => el.hidden = false);
  if (tool === 'symbol') document.querySelectorAll('.mc-prop-symbol').forEach(el => el.hidden = false);
  if (tool === 'dimension') document.querySelectorAll('.mc-prop-dimension').forEach(el => el.hidden = false);
  updateToolButtons(); renderCanvas();
}
function clearDraft() { state.draft = []; state.draftStart = null; state.draftEnd = null; state.dimensionStart = null; updateToolButtons(); }

function getCanvasPoint(event) {
  const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) return {x:0,y:0};
  const p = point.matrixTransform(matrix.inverse());
  const project = state.project;
  return { x: Math.max(0, Math.min(project.width, p.x)), y: Math.max(0, Math.min(project.height, p.y)) };
}
function distance(a,b) { return Math.hypot(a.x-b.x, a.y-b.y); }
function nearestPipeProjection(point) {
  const limit = safeNum($('snapRadius').value, 14);
  if (limit <= 0) return null;
  let best = null;
  for (const pipe of state.project.pipes) {
    if (pipe.visible === false || (pipe.reviewOnly === true && !state.showReviewCandidates)) continue;
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
  const actual = attachment ? {x:attachment.point.x,y:attachment.point.y} : point;
  if (state.draft.length && distance(actual,state.draft[state.draft.length-1]) < 1.5) return;
  state.draft.push(actual);
  if (isStart) state.draftStart = attachment;
  state.draftEnd = attachment;
  renderCanvas(); updateToolButtons();
}
function finishRoute() {
  if (state.draft.length < 2) { toast('Для трубы нужно хотя бы две точки.'); return; }
  pushUndo();
  const id=uid('pipe');
  const name=$('pipeName').value.trim(); const diameter=$('pipeDiameter').value.trim();
  const startAttachment=state.draftStart;
  // Resolve the final snap before inserting the new pipe, so a route cannot snap to itself.
  const endAttachment=nearestPipeProjection(state.draft[state.draft.length-1]);
  const pipe={id,name,diameter,kind:state.tool==='branch'?'branch':$('pipeKind').value==='riser'?'riser':'pipe',points:state.draft.map(p=>[p.x,p.y]),visible:true};
  state.project.pipes.push(pipe);
  if (startAttachment) commitJunction(startAttachment,id);
  if (endAttachment) commitJunction(endAttachment,id);
  state.selected={type:'pipe',id}; clearDraft(); renderAll(); scheduleSave(); toast('Трубопровод добавлен. Узлы привязки отмечены явно.');
}
function handleCanvasClick(event) {
  if (!state.project) return;
  if (state.justDragged) { state.justDragged = false; return; }
  const point=getCanvasPoint(event);
  $('cursorPosition').textContent=`X: ${Math.round(point.x)} · Y: ${Math.round(point.y)}`;
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
  } else state.selected=null;
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
  const caption=symbol.label?`<text x="0" y="${s*1.8}" text-anchor="middle">${esc(symbol.label)}</text>`:'';
  return `<g class="mc-cad-symbol ${state.selected?.type==='symbol'&&state.selected.id===symbol.id?'is-selected':''}" data-element-type="symbol" data-element-id="${esc(symbol.id)}" transform="translate(${x} ${y}) rotate(${rotate})">${shape}${caption}</g>`;
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
    return `<g data-element-type="pipe" data-element-id="${esc(pipe.id)}"><polyline class="mc-pipe-hit" points="${points}"/><polyline class="mc-pipe mc-pipe-${esc(pipe.kind||'pipe')} ${reviewClass} ${selected?'is-selected':''}" points="${points}"/>${selected?pipe.points.map((pair,index)=>`<circle class="mc-vertex" data-vertex-pipe="${esc(pipe.id)}" data-vertex-index="${index}" cx="${pair[0]}" cy="${pair[1]}" r="8"/>`).join(''):''}</g>`;
  }).join('');
  const junctions=p.junctions.map(j=>`<circle class="mc-junction" cx="${j.x}" cy="${j.y}" r="5"><title>Соединение: ${j.pipeIds.length} участка</title></circle>`).join('');
  const symbols=p.symbols.map(symbolSvg).join('');
  const labels=p.labels.map(item=>`<text class="mc-cad-label ${state.selected?.type==='label'&&state.selected.id===item.id?'is-selected':''}" data-element-type="label" data-element-id="${esc(item.id)}" x="${item.x}" y="${item.y}" font-size="${item.size}" text-anchor="${item.anchor||'start'}" transform="rotate(${item.rotation||0} ${item.x} ${item.y})">${esc(item.text)}</text>`).join('');
  const dimensions=p.dimensions.map(item=>`<g data-element-type="dimension" data-element-id="${esc(item.id)}"><path class="mc-dimension" d="M ${item.a[0]} ${item.a[1]} L ${item.b[0]} ${item.b[1]} M ${item.a[0]-5} ${item.a[1]-5} l 10 10 M ${item.b[0]-5} ${item.b[1]-5} l 10 10"/><text class="mc-dimension-text" x="${(item.a[0]+item.b[0])/2}" y="${(item.a[1]+item.b[1])/2-8}" text-anchor="middle">${esc(item.text)}</text></g>`).join('');
  let draft='';
  if(state.draft.length){const points=state.draft.map(pt=>`${pt.x},${pt.y}`).join(' ');draft=`<polyline class="mc-draft" points="${points}"/>${state.draft.map(pt=>`<circle class="mc-snap-ring" cx="${pt.x}" cy="${pt.y}" r="7"/>`).join('')}`;}
  if(state.dimensionStart) draft+=`<circle class="mc-snap-ring" cx="${state.dimensionStart[0]}" cy="${state.dimensionStart[1]}" r="7"/>`;
  svg.innerHTML=`<defs><pattern id="mcGrid" width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" fill="none" stroke="#dce4de" stroke-width="1"/></pattern></defs><rect width="${p.width}" height="${p.height}" fill="#fff"/>${grid}${source}${pipes}${junctions}${dimensions}${symbols}${labels}${draft}`;
  svg.className.baseVal=`tool-${state.tool}`;
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
  $('selectedSymbolWrap').hidden=state.selected.type!=='symbol';
  $('selectedSymbolLabel').value=item.label||'';
  $('selectedHelp').textContent=state.selected.type==='pipe'?(item.reviewOnly ? (item.reviewReason || 'Кандидат не включён в чистовой экспорт. Сверь его с исходной фотографией.') : 'В режиме «Выбор» перетаскивай круглые маркеры вершин на линии. Ответвления соединяются только в точке привязки.'):'Перетаскивай элемент мышью, чтобы изменить положение.';
  $('acceptReviewPipeBtn').hidden=!(state.selected.type==='pipe' && item.reviewOnly===true);
  updateDeleteButton();
}
function renderAll(){syncControls();renderCanvas();renderProjectList();}

function deleteSelected() {
  if(!state.selected||!state.project)return;
  const {type,id}=state.selected; pushUndo();
  if(type==='pipe'){
    state.project.pipes=state.project.pipes.filter(x=>x.id!==id);
    state.project.junctions=state.project.junctions.map(j=>({...j,pipeIds:j.pipeIds.filter(pid=>pid!==id)})).filter(j=>j.pipeIds.length>=2);
  } else if(type==='symbol') state.project.symbols=state.project.symbols.filter(x=>x.id!==id);
  else if(type==='label') state.project.labels=state.project.labels.filter(x=>x.id!==id);
  else if(type==='dimension') state.project.dimensions=state.project.dimensions.filter(x=>x.id!==id);
  state.selected=null; renderAll(); scheduleSave();
}

function startDrag(event) {
  if(state.tool!=='select'||!state.project)return;
  const vertex=event.target.closest('[data-vertex-pipe][data-vertex-index]');
  const item=event.target.closest('[data-element-type][data-element-id]');
  if(vertex){
    state.selected={type:'pipe',id:vertex.dataset.vertexPipe};
    const pipe=state.project.pipes.find(x=>x.id===state.selected.id); if(!pipe)return;
    const index=Number(vertex.dataset.vertexIndex);
    const coordinate=pipe.points[index];
    const junction=state.project.junctions.find(j=>Math.hypot(j.x-coordinate[0],j.y-coordinate[1])<=2);
    pushUndo(); state.drag=junction?{type:'junction',id:junction.id}:{type:'vertex',id:pipe.id,index};
    svg.setPointerCapture?.(event.pointerId); event.preventDefault(); renderCanvas(); return;
  }
  if(item&&['symbol','label'].includes(item.dataset.elementType)){
    state.selected={type:item.dataset.elementType,id:item.dataset.elementId};
    const value=selectedItem(); if(!value)return;
    pushUndo(); state.drag={type:item.dataset.elementType,id:value.id,origin:getCanvasPoint(event),start:{x:value.x,y:value.y}};
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
  } else {
    const collection=drag.type==='symbol'?'symbols':'labels'; const item=state.project[collection].find(x=>x.id===drag.id);
    if(item){item.x=Math.max(0,Math.min(state.project.width,drag.start.x+pt.x-drag.origin.x));item.y=Math.max(0,Math.min(state.project.height,drag.start.y+pt.y-drag.origin.y));}
  }
  renderCanvas();
}
function endDrag(){if(!state.drag)return;state.drag=null;state.justDragged=true;setTimeout(()=>{state.justDragged=false;},0);scheduleSave();renderAll();}

async function uploadSource(file) {
  if(!state.project||!file)return;
  if(file.size>18*1024*1024){toast('Файл больше 18 МБ.');return;}
  const image=new Image(); const objectUrl=URL.createObjectURL(file);
  try{
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Не удалось прочитать изображение.'));image.src=objectUrl;});
    const form=new FormData();form.append('source',file);form.append('width',String(image.naturalWidth));form.append('height',String(image.naturalHeight));
    setSaveState('Загружаю подложку…','busy');
    const data=await api(`/api/manual-cad/projects/${state.project.id}/source`,{method:'POST',body:form});
    state.project=ensureProjectDefaults(data.project);state.sourceVisible=true;syncControls();renderCanvas();await refreshProjectList();setSaveState('Подложка загружена','saved');
    toast(`Подложка загружена: ${image.naturalWidth} × ${image.naturalHeight}. Теперь можно обводить маршруты.`);
  }catch(error){setSaveState('Ошибка загрузки','error');toast(error.message);}finally{URL.revokeObjectURL(objectUrl);$('sourceFile').value='';}
}

// Toolbar and document settings
$('newProjectBtn').addEventListener('click',()=>createProject(true));
document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>setTool(button.dataset.tool)));
$('finishRouteBtn').addEventListener('click',finishRoute);
$('undoBtn').addEventListener('click',undo);$('redoBtn').addEventListener('click',redo);$('deleteBtn').addEventListener('click',deleteSelected);
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
  if(event.key==='Escape'){clearDraft();renderCanvas();return;}
  if(event.key==='Enter'&&['pipe','branch'].includes(state.tool)){event.preventDefault();finishRoute();return;}
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
$('showReviewCandidates').addEventListener('change',event=>{state.showReviewCandidates=event.target.checked;renderCanvas();});
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
