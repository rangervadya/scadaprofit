'use strict';
const frame = document.querySelector('.conclusion-frame');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dt = value => value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
let conclusionContext = null;
let defectFilesForReset = [];
let schemePayloadForReset = [];

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
  if (!report.schemeSvgUrl) throw new Error(`Нет готовой CAD-схемы: ${report.street}, дом ${report.address}`);
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
    return { id: report.id, street: report.street, address: report.address, userName: report.userName, submittedAt: report.submittedAt, status: report.status, pngBase64: await blobToBase64(png) };
  } finally { URL.revokeObjectURL(objectUrl); }
}

function taskAddress(task) {
  return [task?.street, task?.address ? `дом ${task.address}` : ''].filter(Boolean).join(', ');
}

function addNotice(doc, section, id, title, body) {
  if (!section) return;
  let note = doc.getElementById(id);
  if (!note) {
    note = doc.createElement('div'); note.id = id;
    note.style.cssText = 'margin:12px 0 16px;padding:13px 15px;border:1px solid #b9d5eb;border-radius:10px;background:#f3f8fc;color:#234a6b;font-size:12px;line-height:1.55';
    section.insertBefore(note, section.children[1] || null);
  }
  note.replaceChildren();
  const strong = doc.createElement('strong'); strong.textContent = title;
  const text = doc.createElement('div'); text.textContent = body;
  note.append(strong, text);
}

function updateGenerationState(doc, ready, message) {
  const hidden = doc.getElementById('workforce_schemes_json');
  const status = doc.getElementById('workforceMaterialsStatus') || doc.getElementById('workforceSchemesStatus');
  if (hidden) hidden.dataset.ready = ready ? '1' : '0';
  if (status && message) status.textContent = message;
  const hasSelectedMaterials = Boolean((conclusionContext?.reports || []).length || (conclusionContext?.defectReports || []).length);
  if (hasSelectedMaterials) {
    doc.querySelectorAll('.sticky button[onclick^="submitAction("]').forEach(button => {
      button.disabled = !ready;
      button.title = ready ? '' : 'Дождитесь загрузки выбранных схем и фотографий в заключение.';
    });
  }
}

async function buildSchemePayload(doc, reports) {
  const payload = [];
  updateGenerationState(doc, false, 'Подготавливаю принятые CAD-схемы для пункта 7…');
  for (let index = 0; index < reports.length; index += 1) {
    payload.push(await renderSchemeAsPng(reports[index]));
    updateGenerationState(doc, false, `Подготовлено CAD-схем: ${index + 1} из ${reports.length}.`);
  }
  schemePayloadForReset = payload;
  const hidden = doc.getElementById('workforce_schemes_json') || doc.createElement('input');
  hidden.type = 'hidden'; hidden.id = 'workforce_schemes_json'; hidden.name = 'workforce_schemes_json'; hidden.dataset.noExport = '1';
  if (!hidden.parentElement) doc.getElementById('form').appendChild(hidden);
  hidden.value = JSON.stringify(payload);
  hidden.defaultValue = hidden.value;
  hidden.dataset.ready = '1';
  return payload;
}

async function convertDefectBlob(blob, photo) {
  const type = String(blob.type || photo.mimeType || '').toLowerCase();
  const supported = ['image/jpeg', 'image/png', 'image/webp'];
  if (supported.includes(type) && blob.size <= 15 * 1024 * 1024) {
    return new File([blob], photo.originalName || `defect-${photo.id}.jpg`, { type });
  }
  if (typeof createImageBitmap !== 'function') {
    throw new Error(`Браузер не может преобразовать формат ${photo.originalName}. Открой оригинал и сохрани его как JPG или PNG.`);
  }
  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new Error(`Не удалось открыть ${photo.originalName}. Сохрани фотографию как JPG или PNG и отправь её повторно.`); }
  try {
    if (bitmap.width < 150 || bitmap.height < 150) throw new Error(`Фотография ${photo.originalName} меньше минимального размера 150×150 пикселей.`);
    const maxSide = 2600;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(150, Math.round(bitmap.width * scale));
    canvas.height = Math.max(150, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Не удалось подготовить фотографию для приложения 3.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Не удалось сохранить JPEG.')), 'image/jpeg', 0.88));
    if (jpeg.size > 15 * 1024 * 1024) throw new Error(`Фотография ${photo.originalName} после преобразования превышает 15 МБ.`);
    const baseName = String(photo.originalName || `defect-${photo.id}`).replace(/\.[^.]+$/, '');
    return new File([jpeg], `${baseName}.jpg`, { type: 'image/jpeg' });
  } finally { bitmap.close?.(); }
}

async function fetchDefectFiles(defectReports) {
  const files = [];
  for (const report of defectReports) {
    for (const photo of report.photos || []) {
      const response = await fetch(photo.url, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Не удалось загрузить фото «${photo.originalName}» (HTTP ${response.status}).`);
      const blob = await response.blob();
      const file = await convertDefectBlob(blob, photo);
      files.push({ file, street: report.street, address: report.address, reportId: report.id, originalName: photo.originalName });
    }
  }
  defectFilesForReset = files;
  return files;
}

function injectDefectFiles(doc) {
  const grid = doc.getElementById('photo-grid');
  if (!grid || !defectFilesForReset.length) return;
  const win = frame.contentWindow;
  for (const entry of defectFilesForReset) {
    const alreadyInserted = [...grid.querySelectorAll('input[type="file"][name^="photo_"]')].some(input => input.dataset.workforcePhoto === entry.reportId + ':' + entry.originalName);
    if (alreadyInserted) continue;
    let input = [...grid.querySelectorAll('input[type="file"][name^="photo_"]')].find(item => !item.files || !item.files.length);
    if (!input && typeof win.addPhotoRow === 'function') {
      win.addPhotoRow(true);
      input = [...grid.querySelectorAll('input[type="file"][name^="photo_"]')].find(item => !item.files || !item.files.length);
    }
    if (!input) throw new Error('Не удалось создать поле для фотографии дефекта в Приложении 3.');
    const transfer = new DataTransfer();
    transfer.items.add(entry.file);
    input.files = transfer.files;
    input.dataset.workforcePhoto = entry.reportId + ':' + entry.originalName;
    const match = input.name.match(/^photo_(\d+)$/);
    if (match && typeof win.photoSelected === 'function') win.photoSelected(Number(match[1]), input);
    else input.dispatchEvent(new win.Event('change', { bubbles: true }));
  }
  const confirm = doc.querySelector('input[name="photo_content_confirm"]');
  if (confirm) confirm.checked = false;
}

function installConclusionBridge() {
  if (!frame || !conclusionContext) return;
  let doc;
  try { doc = frame.contentDocument; } catch { return; }
  const form = doc?.getElementById('form');
  if (!form || form.dataset.workforceContextInstalled === '1') return;
  form.dataset.workforceContextInstalled = '1';
  const task = conclusionContext.task;
  const addressValue = taskAddress(task);
  const addressField = form.querySelector('[name="address"]');
  if (addressField && !String(addressField.value || '').trim()) addressField.value = addressValue;

  const acceptedSchemes = conclusionContext.reports || [];
  const acceptedDefects = conclusionContext.defectReports || [];
  const materialsSection = doc.getElementById('materials');
  const photosSection = doc.getElementById('photos');
  const materialJobs = [];
  const hasSelectedMaterials = acceptedSchemes.length > 0 || acceptedDefects.length > 0;
  if (hasSelectedMaterials) {
    const statusSection = acceptedSchemes.length ? materialsSection : photosSection;
    const materialStatus = doc.createElement('p');
    materialStatus.id = 'workforceMaterialsStatus';
    materialStatus.setAttribute('role', 'status');
    materialStatus.style.cssText = 'margin:8px 0 12px;color:#315e83;font-size:12px;font-weight:650';
    statusSection?.appendChild(materialStatus);
    updateGenerationState(doc, false, 'Подготавливаю выбранные материалы этого дома для PDF и Word…');
  }
  if (acceptedSchemes.length) {
    addNotice(doc, materialsSection, 'workforceSchemeNotice', 'Схемы для пункта 7 добавлены приёмщиком', acceptedSchemes.map(report => `${report.street}, дом ${report.address} · ${report.userName}`).join('\n'));
    const status = doc.createElement('p'); status.id = 'workforceSchemesStatus'; status.setAttribute('role', 'status');
    status.style.cssText = 'margin:8px 0 0;color:#315e83;font-size:12px;font-weight:650';
    const hidden = doc.getElementById('workforce_schemes_json') || doc.createElement('input');
    hidden.type = 'hidden'; hidden.id = 'workforce_schemes_json'; hidden.name = 'workforce_schemes_json'; hidden.dataset.noExport = '1'; hidden.dataset.ready = '0';
    if (!hidden.parentElement) form.appendChild(hidden);
    materialsSection?.appendChild(status);
    materialJobs.push(buildSchemePayload(doc, acceptedSchemes).then(() => { status.textContent = 'CAD-схемы подготовлены и будут вставлены в пункт 7 PDF и Word.'; }));
  }
  if (acceptedDefects.length) {
    const defectDescription = acceptedDefects.map(report => `${report.street}, дом ${report.address}: ${report.photos?.length || 0} фото`).join('; ');
    addNotice(doc, photosSection, 'workforceDefectNotice', 'Фотографии дефектов добавлены из принятого отчёта', `${defectDescription}. Эти снимки будут помещены в штатные фотослоты и напечатаны в Приложении 3 «Фото дефектного участка». Проверьте фотографии и самостоятельно поставьте обязательную галочку подтверждения ниже.`);
    materialJobs.push(fetchDefectFiles(acceptedDefects).then(files => {
      injectDefectFiles(doc);
      const note = doc.getElementById('workforceDefectNotice');
      if (note) {
        const summary = doc.createElement('div'); summary.style.marginTop = '6px';
        summary.textContent = `Загружено в Приложение 3: ${files.length} фото. Поля фото заполнены автоматически; галочку подтверждения необходимо поставить после проверки.`;
        note.appendChild(summary);
      }
    }).catch(error => {
      const note = doc.getElementById('workforceDefectNotice');
      if (note) { const warning = doc.createElement('div'); warning.style.cssText = 'margin-top:6px;color:#a33;font-weight:700'; warning.textContent = `Не удалось добавить фотографии: ${error.message}`; note.appendChild(warning); }
      throw error;
    }));
  }
  if (task) {
    const addressNote = `${addressValue}. В это заключение автоматически включаются только материалы, которые приёмщик отдельно добавил именно для этого задания.`;
    addNotice(doc, form.querySelector('#main'), 'workforceTaskAddressNotice', 'Текущий адрес заключения', addressNote);
  }

  if (materialJobs.length) {
    Promise.all(materialJobs).then(() => {
      updateGenerationState(doc, true, `Все выбранные материалы для ${addressValue} готовы. Можно формировать PDF или Word.`);
    }).catch(error => {
      updateGenerationState(doc, false, `Не удалось полностью подготовить материалы: ${error.message}. Формирование заблокировано, чтобы не выпустить документ без вложений.`);
    });
  }

  // Keep selected materials after the form's native "Очистить форму" action.
  const initialSchemeValue = doc.getElementById('workforce_schemes_json')?.value || '';
  const hidden = doc.getElementById('workforce_schemes_json');
  if (hidden) hidden.defaultValue = initialSchemeValue;
  form.addEventListener('reset', () => {
    setTimeout(() => {
      const currentDoc = frame.contentDocument;
      if (!currentDoc) return;
      currentDoc.querySelectorAll('input[type="file"][data-workforce-photo]').forEach(input => { delete input.dataset.workforcePhoto; });
      const currentHidden = currentDoc.getElementById('workforce_schemes_json');
      if (currentHidden && schemePayloadForReset.length) {
        currentHidden.value = JSON.stringify(schemePayloadForReset);
        currentHidden.defaultValue = currentHidden.value;
        currentHidden.dataset.ready = '1';
      }
      if (defectFilesForReset.length) injectDefectFiles(currentDoc);
    }, 80);
  });

  if (acceptedSchemes.length) {
    const hiddenField = doc.getElementById('workforce_schemes_json');
    const frameWindow = frame.contentWindow;
    if (frameWindow && typeof frameWindow.submitAction === 'function' && !frameWindow.submitAction.__workforceBridge) {
      const original = frameWindow.submitAction;
      const wrapped = function(url, preview) {
        if (hiddenField?.dataset.ready !== '1' || !hiddenField.value) {
          try { frameWindow.showStatus?.('err', 'Подготовка CAD-схем для пункта 7 ещё не завершена. Дождитесь сообщения о готовности.'); } catch {}
          return;
        }
        return original.call(frameWindow, url, preview);
      };
      wrapped.__workforceBridge = true;
      frameWindow.submitAction = wrapped;
      if (hiddenField.dataset.ready !== '1') {
        doc.querySelectorAll('.sticky button[onclick^="submitAction("]').forEach(button => { button.disabled = true; });
      }
    }
  }
}

async function loadWorkforceConclusion() {
  const params = new URLSearchParams(window.location.search);
  const query = new URLSearchParams();
  for (const key of ['task', 'report', 'defectReport']) {
    const value = params.get(key);
    if (value) { query.set(key, value); break; }
  }
  if (!query.size) return; // Manual conclusion stays completely standalone.
  try {
    const response = await fetch(`/api/workforce/conclusion?${query.toString()}`, { cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { window.location.replace('/login.html'); return; }
    if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    if (!data.task) return;
    conclusionContext = data;
    if (frame?.contentDocument?.readyState === 'complete') installConclusionBridge();
  } catch (error) {
    const banner = document.createElement('div');
    banner.style.cssText = 'margin:0 0 12px;padding:12px;border:1px solid #e5b5b5;border-radius:9px;background:#fff7f7;color:#943c3c;font-size:13px';
    banner.textContent = `Не удалось загрузить выбранные материалы выезда: ${error.message}`;
    document.querySelector('.app-shell')?.prepend(banner);
  }
}

if (frame) frame.addEventListener('load', installConclusionBridge);
loadWorkforceConclusion();
