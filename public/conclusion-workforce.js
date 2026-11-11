'use strict';
const root = document.getElementById('workforceConclusionSection');
const list = document.getElementById('workforceConclusionList');
const frame = document.querySelector('.conclusion-frame');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dt = value => value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
let workforceReports = [];
const pngCache = new Map();

function blobToBase64(blob) {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
    }
    return btoa(binary);
  });
}

async function renderSchemeAsPng(report) {
  if (!report.schemeSvgUrl) throw new Error(`Нет готового CAD-предпросмотра: ${report.street}, дом ${report.address}`);
  const response = await fetch(report.schemeSvgUrl, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Не удалось получить CAD-схему: ${report.street}, дом ${report.address} (HTTP ${response.status})`);
  const svgText = await response.text();
  if (!/<svg[\s>]/i.test(svgText)) throw new Error(`CAD-файл не является SVG: ${report.street}, дом ${report.address}`);
  const objectUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image(); image.decoding = 'async'; image.src = objectUrl;
    if (typeof image.decode === 'function') await image.decode();
    else await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    const sourceWidth = image.naturalWidth || 1600;
    const sourceHeight = image.naturalHeight || 1200;
    const scale = Math.min(1.5, 2600 / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(150, Math.round(sourceWidth * scale));
    canvas.height = Math.max(150, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Браузер не смог подготовить изображение CAD-схемы.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось преобразовать CAD-схему в PNG.')), 'image/png'));
    if (png.size > 12 * 1024 * 1024) throw new Error(`Слишком большой файл CAD-схемы: ${report.street}, дом ${report.address}`);
    return {
      id: report.id, street: report.street, address: report.address,
      userName: report.userName, submittedAt: report.submittedAt, status: report.status,
      pngBase64: await blobToBase64(png)
    };
  } finally { URL.revokeObjectURL(objectUrl); }
}

function getPngPayload(report) {
  if (!pngCache.has(report.id)) pngCache.set(report.id, renderSchemeAsPng(report));
  return pngCache.get(report.id);
}

function setFormGenerationEnabled(doc, enabled) {
  doc.querySelectorAll('.sticky button[onclick^="submitAction("]').forEach(button => {
    button.disabled = !enabled;
    button.title = enabled ? '' : 'Сначала дождитесь подготовки выбранных CAD-схем для пункта 7.';
  });
}

async function syncWorkforceSchemesToForm(doc) {
  const hidden = doc.getElementById('workforce_schemes_json');
  const status = doc.getElementById('workforceSchemesStatus');
  if (!hidden) return;
  const selectedIds = [...doc.querySelectorAll('[data-workforce-include]')].filter(input => input.checked).map(input => input.value);
  const selected = selectedIds.map(id => workforceReports.find(report => report.id === id)).filter(Boolean);
  setFormGenerationEnabled(doc, false);
  if (status) status.textContent = selected.length ? `Подготавливаю схемы для документа: 0 из ${selected.length}…` : 'Ни одна схема из выездов не выбрана. Остальные поля пункта 7 работают как обычно.';
  try {
    const payload = [];
    for (let index = 0; index < selected.length; index += 1) {
      payload.push(await getPngPayload(selected[index]));
      if (status) status.textContent = `Подготовлено схем для документа: ${index + 1} из ${selected.length}.`;
    }
    hidden.value = JSON.stringify(payload); hidden.dataset.ready = '1';
    if (status) status.textContent = selected.length
      ? `Готово: ${selected.length} CAD-схем будут вставлены в пункт 7 PDF и Word.`
      : 'Ни одна схема из выездов не выбрана. Остальные поля пункта 7 работают как обычно.';
    setFormGenerationEnabled(doc, true);
  } catch (error) {
    hidden.value = ''; hidden.dataset.ready = '0';
    if (status) status.textContent = `Не удалось подготовить вложения: ${error.message}. Снимите отметку с недоступной схемы или обновите страницу.`;
    setFormGenerationEnabled(doc, false);
    throw error;
  }
}

function installSection7Bridge() {
  if (!frame || !workforceReports.length) return;
  let doc;
  try { doc = frame.contentDocument; } catch { return; }
  const form = doc?.getElementById('form');
  const section = doc?.getElementById('materials');
  if (!form || !section) return;
  let panel = doc.getElementById('workforceGeneratedSchemes');
  if (!panel) {
    panel = doc.createElement('div'); panel.id = 'workforceGeneratedSchemes';
    panel.style.cssText = 'margin:14px 0 18px;padding:15px;border:1px solid #b9d5eb;border-radius:12px;background:#f3f8fc';
    const title = doc.createElement('h3'); title.textContent = 'Схемы, полученные от слесарей';
    title.style.cssText = 'margin:0 0 6px;color:#234a6b;font-size:16px';
    const description = doc.createElement('p');
    description.textContent = 'Отметьте схемы, которые нужно автоматически вставить в этот документ. Они попадут в PDF и Word как страницы раздела 7 с адресом и ФИО слесаря. Неотмеченные схемы останутся только в списке заключения.';
    description.style.cssText = 'margin:0 0 10px;color:#52677c;font-size:12px;line-height:1.5';
    const choices = doc.createElement('div'); choices.id = 'workforceGeneratedSchemeChoices';
    choices.style.cssText = 'display:grid;gap:8px';
    const status = doc.createElement('p'); status.id = 'workforceSchemesStatus';
    status.setAttribute('role', 'status');
    status.style.cssText = 'margin:10px 0 0;color:#315e83;font-size:12px;font-weight:650';
    panel.append(title, description, choices, status);
    const attachmentGrid = section.querySelector('.attachment-grid');
    section.insertBefore(panel, attachmentGrid || null);
  }
  const choices = panel.querySelector('#workforceGeneratedSchemeChoices');
  const hidden = doc.getElementById('workforce_schemes_json') || doc.createElement('input');
  hidden.type = 'hidden'; hidden.id = 'workforce_schemes_json'; hidden.name = 'workforce_schemes_json';
  hidden.dataset.noExport = '1';
  if (!hidden.parentElement) form.appendChild(hidden);
  const focusId = new URLSearchParams(window.location.search).get('report');
  choices.innerHTML = workforceReports.map(report => {
    const disabled = !report.schemeSvgUrl;
    const checked = !disabled && Boolean(focusId && report.id === focusId);
    return `<label style="display:flex;gap:9px;align-items:flex-start;padding:9px;border:1px solid #d8e5ef;border-radius:8px;background:#fff;color:#27445e;font-size:12px;line-height:1.45"><input type="checkbox" data-workforce-include value="${esc(report.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} style="margin-top:2px"><span><b>${esc(report.street)}, дом ${esc(report.address)}</b><br>${esc(report.userName)} · ${esc(dt(report.submittedAt))}${disabled ? '<br><span style="color:#a33">CAD-предпросмотр недоступен — схема не попадёт в документ</span>' : ''}</span></label>`;
  }).join('');
  choices.querySelectorAll('[data-workforce-include]').forEach(input => input.addEventListener('change', () => syncWorkforceSchemesToForm(doc).catch(() => {})));

  const frameWindow = frame.contentWindow;
  if (frameWindow && typeof frameWindow.submitAction === 'function' && !frameWindow.submitAction.__workforceBridge) {
    const original = frameWindow.submitAction;
    const wrapped = function(url, preview) {
      if (hidden.dataset.ready !== '1') {
        try { frameWindow.showStatus?.('err', 'Подготовка CAD-схем для пункта 7 ещё не завершена. Дождитесь сообщения «Готово» и повторите формирование.'); } catch {}
        return;
      }
      return original.call(frameWindow, url, preview);
    };
    wrapped.__workforceBridge = true; frameWindow.submitAction = wrapped;
  }
  if (hidden.dataset.ready !== '1') syncWorkforceSchemesToForm(doc).catch(() => {});
}

async function loadWorkforceConclusion() {
  if (!root || !list) return;
  try {
    const response = await fetch('/api/workforce/conclusion', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { window.location.replace('/login.html'); return; }
    if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    workforceReports = data.reports || [];
    if (!workforceReports.length) return;
    root.hidden = false;
    const focusId = new URLSearchParams(window.location.search).get('report');
    list.innerHTML = workforceReports.map(report => `
      <article class="conclusion-scheme-card" id="conclusion-scheme-${esc(report.id)}">
        <div class="conclusion-scheme-meta">
          <h3>${esc(report.street)}, дом ${esc(report.address)}</h3>
          <p>Слесарь: ${esc(report.userName)}<br>Получено: ${esc(dt(report.submittedAt))}<br>Добавлено в заключение: ${esc(dt(report.conclusionAddedAt))}</p>
          ${report.note ? `<p>${esc(report.note)}</p>` : ''}
          <div class="conclusion-scheme-actions">
            <button type="button" data-open-cad="${esc(report.schemeJobId || '')}">Открыть CAD-редактор</button>
            ${report.schemeSvgUrl ? `<a href="${esc(report.schemeSvgUrl)}" target="_blank" rel="noopener">Схема SVG</a>` : ''}
            ${report.schemeDxfUrl ? `<a href="${esc(report.schemeDxfUrl)}" download>Чертёж DXF</a>` : ''}
          </div>
        </div>
        <div class="conclusion-scheme-preview">${report.schemeSvgUrl ? `<img src="${esc(report.schemeSvgUrl)}" alt="CAD-схема: ${esc(report.street)}, дом ${esc(report.address)}" loading="lazy">` : '<span>Предпросмотр CAD-схемы недоступен</span>'}</div>
      </article>`).join('');
    list.querySelectorAll('[data-open-cad]').forEach(button => button.addEventListener('click', async () => {
      const jobId = button.dataset.openCad;
      if (!jobId) return;
      button.disabled = true; button.textContent = 'Открываю…';
      try {
        const response = await fetch(`/api/manual-cad/import-job/${encodeURIComponent(jobId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Не удалось открыть CAD-редактор.');
        window.location.href = result.project.editUrl || `/manual-cad.html?project=${encodeURIComponent(result.project.id)}`;
      } catch (error) { button.disabled = false; button.textContent = error.message; }
    }));
    if (focusId) document.getElementById(`conclusion-scheme-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    installSection7Bridge();
  } catch (error) {
    root.hidden = false;
    list.innerHTML = `<p class="conclusion-empty">Не удалось загрузить схемы из выездов: ${esc(error.message)}</p>`;
  }
}

if (frame) frame.addEventListener('load', installSection7Bridge);
loadWorkforceConclusion();
