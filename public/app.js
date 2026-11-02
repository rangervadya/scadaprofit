const $ = (id) => document.getElementById(id);
let selectedFile = null;
let graph = null;
let connectMode = false;
let firstNode = null;
let draggingNode = null;
let showAllSegments = false;

const fileInput = $('fileInput');
const dropzone = $('dropzone');
fileInput.addEventListener('change', () => setFile(fileInput.files?.[0]));
for (const name of ['dragenter','dragover']) dropzone.addEventListener(name, e => {e.preventDefault();dropzone.classList.add('over')});
for (const name of ['dragleave','drop']) dropzone.addEventListener(name, e => {e.preventDefault();dropzone.classList.remove('over')});
dropzone.addEventListener('drop', e => setFile(e.dataTransfer.files?.[0]));
function setFile(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp|tiff)$/.test(file.type)) { alert('Поддерживаются JPG, PNG, WEBP и TIFF.'); return; }
  selectedFile = file; $('fileName').textContent = file.name; $('analyzeBtn').disabled = false;
  graph = null; $('statsPanel').hidden = true; $('edgePanel').hidden = true; $('nodePanel').hidden = true; $('textPanel').hidden = true;
  $('sourceStage').classList.add('empty'); $('sourceStage').classList.remove('loaded'); $('sourceImage').src = '';
  $('cleanStage').innerHTML = '<div class="emptymsg">Нажми «Найти линии» для анализа фотографии.</div>';
}

$('analyzeBtn').addEventListener('click', async () => {
  if (!selectedFile) return;
  $('analyzeBtn').disabled = true; $('progress').classList.add('active'); $('analyzeBtn').textContent = 'Анализирую изображение…';
  try {
    const fd = new FormData(); fd.append('image', selectedFile);
    const res = await fetch('/api/analyze', {method:'POST', body:fd});
    const data = await res.json(); if (!res.ok) throw new Error(data.details || data.error || 'Ошибка анализа');
    graph = data; showAllSegments = false; connectMode=false; firstNode=null;
    showResult();
  } catch (e) { alert(`Не удалось выполнить анализ: ${e.message}`); }
  finally { $('progress').classList.remove('active'); $('analyzeBtn').disabled = false; $('analyzeBtn').textContent = 'Найти линии и построить граф'; }
});

function showResult() {
  $('statsPanel').hidden = false; $('edgePanel').hidden = false; $('nodePanel').hidden = false; $('textPanel').hidden = false;
  $('sourceImage').src = graph.sourceUrl; $('sourceStage').classList.remove('empty'); $('sourceStage').classList.add('loaded');
  $('canvasMeta').textContent = `${graph.image.width} × ${graph.image.height} px · геометрия не обрезалась по OCR`;
  $('statusline').textContent = graph.warnings.join(' ');
  const st=graph.summary;
  $('stats').innerHTML = stat(st.segment_candidates,'отрезков-кандидатов')+stat(st.nodes,'узлов')+stat(st.edges,'связей')+stat(st.crossings_to_review,'пересечений на проверку')+stat(st.ocr_annotations,'OCR-подписей')+stat(st.line_components,'компонентов линий')+stat(st.annotation_components,'текстовых компонентов')+stat(st.ambiguous_components,'неоднозначных компонентов');
  $('edgeCount').textContent=graph.edges.length; $('nodeCount').textContent=graph.nodes.length;
  renderOverlay(); renderClean(); renderEdgeList(); renderNodeList(); renderTextList(); renderJoinList();
  for (const id of ['exportSvg','exportDxf','exportJson','exportPdf']) $(id).disabled=false;
}
function stat(n,label){return `<div class="stat"><strong>${escapeHtml(String(n))}</strong><span>${escapeHtml(label)}</span></div>`}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function edgeLength(e){const g=e.geometry||[];if(g.length<2)return 0;return Math.hypot(g[g.length-1][0]-g[0][0],g[g.length-1][1]-g[0][1]);}
function shownEdges(){return graph.edges.filter(e=>e.visible!==false && (showAllSegments || (edgeLength(e)>=28 && e.component_role==='line_structure')));}
function renderOverlay(){
  if(!graph)return;
  const w=graph.image.width,h=graph.image.height;
  const visibleIds=new Set(shownEdges().map(e=>e.id));
  const lines=graph.edges.map(e=>{
    if(!visibleIds.has(e.id))return '';
    const pts=e.geometry.map(p=>`${p[0]},${p[1]}`).join(' ');
    const c=e.source==='manual'?'#cf4f43':(e.detector==='HOUGH'?'#19a36a':'#e38a36');
    return `<polyline data-edge="${e.id}" points="${pts}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>`;
  }).join('');
  const nodes=$('showNodes').checked ? graph.nodes.map(n=>`<g class="node" data-node="${n.id}"><circle cx="${n.x}" cy="${n.y}" r="${n.degree>=3?6:4}" fill="white" stroke="${nodeSelected(n.id)?'#db7627':'#c9443d'}" stroke-width="2.2"/><text x="${n.x+7}" y="${n.y-7}" font-size="10" fill="#20231f" stroke="white" stroke-width="3" paint-order="stroke">${n.id}</text></g>`).join('') : '';
  const crossings=$('showCrossings').checked ? (graph.crossings||[]).map(x=>`<g><circle cx="${x.x}" cy="${x.y}" r="8" fill="none" stroke="#a044b4" stroke-width="2" stroke-dasharray="3 2"/><text x="${x.x+9}" y="${x.y-7}" font-size="10" fill="#8a3d9a">?</text></g>`).join('') : '';
  const svg=$('overlay'); svg.setAttribute('viewBox',`0 0 ${w} ${h}`); svg.setAttribute('preserveAspectRatio','xMidYMid meet'); svg.innerHTML=lines+crossings+nodes;
  svg.querySelectorAll('.node').forEach(g=>{
    g.addEventListener('pointerdown', e=>startNodeAction(e,g.dataset.node));
    g.addEventListener('click', e=>{e.stopPropagation(); if(connectMode) chooseNode(g.dataset.node); else selectNode(g.dataset.node);});
  });
}
function nodeSelected(id){return connectMode && (firstNode===id);}
function selectNode(id){$('selectMode').textContent=`Выбран узел ${id}`;document.querySelectorAll('#nodeList .rowitem').forEach(el=>el.classList.toggle('selected',el.dataset.node===id));}
function startNodeAction(e,id){
  if(connectMode)return;
  if(e.button!==0)return;
  draggingNode=id; $('overlay').setPointerCapture?.(e.pointerId); e.preventDefault();
}
$('overlay').addEventListener('pointermove',e=>{
  if(!draggingNode||!graph)return;
  const svg=$('overlay'),pt=svg.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;const p=pt.matrixTransform(svg.getScreenCTM().inverse());
  moveNode(draggingNode,Math.max(0,Math.min(graph.image.width,p.x)),Math.max(0,Math.min(graph.image.height,p.y)));
});
$('overlay').addEventListener('pointerup',()=>{draggingNode=null;});$('overlay').addEventListener('pointercancel',()=>{draggingNode=null;});
function moveNode(id,x,y){
  const n=graph.nodes.find(n=>n.id===id);if(!n)return;n.x=+x.toFixed(1);n.y=+y.toFixed(1);
  for(const e of graph.edges){if(e.from===id&&e.geometry.length)e.geometry[0]=[n.x,n.y];if(e.to===id&&e.geometry.length)e.geometry[e.geometry.length-1]=[n.x,n.y];}
  renderOverlay();renderClean();renderNodeList();
}
function renderEdgeList(){
  $('edgeList').innerHTML=graph.edges.map(e=>`<label class="rowitem"><input type="checkbox" data-toggle-edge="${e.id}" ${e.visible===false?'':'checked'}><span class="id">${e.id}</span><span class="meta">${edgeLength(e).toFixed(0)} px · ${e.detector} · ${e.component_id||''}</span><span class="mini">${Math.round(e.confidence*100)}%</span></label>`).join('');
  $('edgeList').querySelectorAll('[data-toggle-edge]').forEach(input=>input.addEventListener('change',()=>{const edge=graph.edges.find(x=>x.id===input.dataset.toggleEdge);edge.visible=input.checked;renderOverlay();renderClean();}));
}
function renderNodeList(){
  const important=[...graph.nodes].filter(n=>n.degree!==2).sort((a,b)=>b.degree-a.degree).slice(0,100);
  $('nodeList').innerHTML=important.map(n=>`<div class="rowitem" data-node="${n.id}"><span class="id">${n.id}</span><span class="meta">x ${n.x.toFixed(1)} · y ${n.y.toFixed(1)}</span><span class="mini">${n.degree} конц.</span></div>`).join('') || '<div class="hint">Нет выделенных узлов.</div>';
  $('nodeList').querySelectorAll('[data-node]').forEach(el=>el.addEventListener('click',()=>selectNode(el.dataset.node)));
}
function addManualConnection(from,to){
  const a=graph.nodes.find(n=>n.id===from),b=graph.nodes.find(n=>n.id===to);if(!a||!b||a.id===b.id)return;
  const exists=graph.edges.some(e=>(e.from===a.id&&e.to===b.id)||(e.from===b.id&&e.to===a.id));
  if(exists)return;
  graph.edges.push({id:`E${Math.max(0,...graph.edges.map(e=>Number(e.id.slice(1))||0))+1}`,from:a.id,to:b.id,source:'manual',confidence:1,geometry:[[a.x,a.y],[b.x,b.y]],visible:true,review:false,detector:'MANUAL',suggested_role:'line_candidate'});
  $('edgeCount').textContent=graph.edges.length;renderOverlay();renderClean();renderEdgeList();renderNodeList();renderJoinList();
}
function renderJoinList(){
  const joins=(graph.joinCandidates||[]).slice(0,60);
  $('joinList').innerHTML=joins.length?joins.map(j=>`<div class="rowitem"><span class="id">${j.id}</span><span class="meta">${j.from} ↔ ${j.to} · ${j.distance} px</span><button data-join="${j.id}">Соединить</button></div>`).join(''):'<div class="hint">Нет коротких соосных разрывов-кандидатов.</div>';
  $('joinList').querySelectorAll('[data-join]').forEach(btn=>btn.addEventListener('click',()=>{const j=graph.joinCandidates.find(x=>x.id===btn.dataset.join);if(j){addManualConnection(j.from,j.to);graph.joinCandidates=graph.joinCandidates.filter(x=>x.id!==j.id);renderJoinList();}}));
}
function renderTextList(){
  const ann=graph.annotations.filter(a=>a.source==='tesseract');
  $('textList').innerHTML=ann.length?ann.map(a=>`<div class="rowitem"><input type="checkbox" data-verified="${a.id}" ${a.verified?'checked':''} title="Проверено"><span class="id">${a.id}</span><input type="text" data-text="${a.id}" value="${escapeHtml(a.text)}" aria-label="Текст ${a.id}"><span class="mini">${a.confidence}%</span></div>`).join(''):'<div class="hint">Tesseract не нашёл подписи с достаточной уверенностью. Геометрия от этого не меняется.</div>';
  $('textList').querySelectorAll('[data-text]').forEach(input=>input.addEventListener('input',()=>{const a=graph.annotations.find(x=>x.id===input.dataset.text);a.text=input.value;renderClean();}));
  $('textList').querySelectorAll('[data-verified]').forEach(input=>input.addEventListener('change',()=>{const a=graph.annotations.find(x=>x.id===input.dataset.verified);a.verified=input.checked;renderClean();}));
}
$('allEdges').addEventListener('click',()=>{showAllSegments=true;renderOverlay();renderClean();});
$('longEdges').addEventListener('click',()=>{showAllSegments=false;renderOverlay();renderClean();});
$('showNodes').addEventListener('change',()=>renderOverlay());
$('showCrossings').addEventListener('change',()=>renderOverlay());
$('connectMode').addEventListener('click',()=>{connectMode=!connectMode;firstNode=null;if(connectMode)$('showNodes').checked=true;$('connectHelp').hidden=!connectMode;$('connectMode').textContent=connectMode?'Отмена соединения':'＋ Соединить два выбранных узла';$('selectMode').textContent=connectMode?'Выбери два узла на схеме':'Режим: просмотр';renderOverlay();});
function chooseNode(id){
  if(!firstNode){firstNode=id;$('connectHelp').textContent=`Первый узел: ${id}. Теперь выбери второй узел.`;renderOverlay();return;}
  if(firstNode===id)return;
  const a=graph.nodes.find(n=>n.id===firstNode),b=graph.nodes.find(n=>n.id===id);
  if(!a||!b)return;
  addManualConnection(a.id,b.id);
  connectMode=false;firstNode=null;$('connectHelp').hidden=true;$('connectMode').textContent='＋ Соединить два выбранных узла';$('selectMode').textContent='Добавлено ручное соединение';
  renderOverlay();
}
function buildChains(edges){
  const adj=new Map();
  for(const e of edges){if(!adj.has(e.from))adj.set(e.from,[]);if(!adj.has(e.to))adj.set(e.to,[]);adj.get(e.from).push(e);adj.get(e.to).push(e);}
  const visited=new Set(),chains=[];
  function trace(startNode,firstEdge){
    let node=startNode,edge=firstEdge,pts=[],ids=[];
    while(edge&&!visited.has(edge.id)){
      visited.add(edge.id);ids.push(edge.id);
      let oriented=edge.from===node?edge.geometry:[...edge.geometry].reverse();
      if(!pts.length)pts.push(...oriented);else pts.push(...oriented.slice(1));
      const next=edge.from===node?edge.to:edge.from;
      const candidates=(adj.get(next)||[]).filter(x=>!visited.has(x.id));
      if((adj.get(next)||[]).length!==2||!candidates.length)break;
      node=next;edge=candidates[0];
    }
    if(pts.length>=2)chains.push({points:pts,edgeIds:ids});
  }
  for(const [node,incident] of adj){
    if(incident.length===2)continue;
    for(const e of incident)if(!visited.has(e.id))trace(node,e);
  }
  for(const e of edges)if(!visited.has(e.id))trace(e.from,e);
  return chains;
}
function buildSheetSvg(){
  const w=graph.image.width,h=graph.image.height,edges=shownEdges();
  const margin=75,PW=1200,PH=850,availH=PH-190,scale=Math.min((PW-2*margin)/w,availH/h),ox=(PW-w*scale)/2,oy=70+(availH-h*scale)/2;
  let out=[`<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 ${PW} ${PH}">`,`<rect width="${PW}" height="${PH}" fill="white"/>`,`<rect x="22" y="22" width="1156" height="806" fill="none" stroke="#111" stroke-width="1.2"/>`,`<text x="40" y="49" font-family="Arial,sans-serif" font-size="15" font-weight="bold">СХЕМА ТРУБОПРОВОДА</text>`,`<text x="40" y="65" font-family="Arial,sans-serif" font-size="8" fill="#555">Предварительная векторная реконструкция · требуется проверка соединений</text>`,`<g transform="translate(${ox} ${oy}) scale(${scale})" fill="none" stroke="#111" stroke-width="${Math.max(.45,1.6/scale)}" stroke-linecap="round" stroke-linejoin="round">`];
  for(const chain of buildChains(edges)){const p=chain.points.map(q=>`${q[0]},${q[1]}`).join(' ');out.push(`<polyline points="${p}"/>`);}
  out.push('</g>');
  // Approved text is printed as independent typography, never traced as glyph strokes.
  for(const a of graph.annotations.filter(x=>x.verified&&x.text&&x.bbox)){const b=a.bbox;const x=ox+(b.x+b.w/2)*scale,y=oy+(b.y+b.h/2)*scale;out.push(`<text x="${x}" y="${y}" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#111">${escapeHtml(a.text)}</text>`);}
  out.push('<path d="M22 760 H1178 M820 760 V828" fill="none" stroke="#111" stroke-width=".8"/>','<text x="40" y="782" font-family="Arial,sans-serif" font-size="9">ПРОВЕРИТЬ ВСЕ УЗЛЫ, ПЕРЕСЕЧЕНИЯ И РАЗМЕРЫ ПО ОРИГИНАЛУ</text>','<text x="838" y="782" font-family="Arial,sans-serif" font-size="9">CAD RECONSTRUCTION ENGINE 4.0.0</text>','</svg>');
  return out.join('\n');
}
function renderClean(){if(!graph)return;$('cleanStage').innerHTML=buildSheetSvg();}
function download(name,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function buildDxf(){let d=['0','SECTION','2','HEADER','9','$ACADVER','1','AC1015','0','ENDSEC','0','SECTION','2','ENTITIES'];for(const chain of buildChains(shownEdges())){const p=chain.points;if(!p||p.length<2)continue;d.push('0','LWPOLYLINE','8','PIPE_CANDIDATES','90',String(p.length),'70','0');for(const q of p)d.push('10',String(q[0]),'20',String(graph.image.height-q[1]));}for(const a of graph.annotations.filter(x=>x.verified&&x.text&&x.bbox)){const b=a.bbox;d.push('0','TEXT','8','VERIFIED_TEXT','10',String(b.x),'20',String(graph.image.height-b.y-b.h),'40','8','1',a.text);}d.push('0','ENDSEC','0','EOF');return d.join('\n')+'\n';}
$('exportSvg').addEventListener('click',()=>download('reconstructed-scheme.svg',buildSheetSvg(),'image/svg+xml'));
$('exportDxf').addEventListener('click',()=>download('reconstructed-scheme.dxf',buildDxf(),'application/dxf'));
$('exportJson').addEventListener('click',()=>download('reconstruction-graph.json',JSON.stringify(graph,null,2),'application/json'));

$('exportPdf').addEventListener('click',()=>{
  const popup=window.open('', '_blank');
  if(!popup){alert('Разреши всплывающее окно для печати в PDF.');return;}
  popup.document.open();
  popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Трубопроводная схема</title><style>@page{size:A3 landscape;margin:0}html,body{margin:0;padding:0;width:420mm;height:297mm}svg{display:block;width:420mm;height:297mm}</style></head><body>${buildSheetSvg()}<script>window.onload=()=>setTimeout(()=>window.print(),250)<\/script></body></html>`);
  popup.document.close();
});
