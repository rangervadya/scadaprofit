'use strict';
const $ = id => document.getElementById(id);
const roleLabels = { fitter: 'Слесарь', receiver: 'Приёмщик', supervisor: 'Руководитель', developer: 'Разработчик' };
const statusLabels = { assigned: 'Назначено', in_progress: 'Обход начат', house_visited: 'Дом пройден', at_office: 'В офисе', submitted: 'Эскиз отправлен', processing: 'CAD-обработка', pending_review: 'Готово к проверке', accepted: 'Принято', revision_requested: 'На исправление', processing_failed: 'Ошибка CAD-обработки' };
let currentUser = null;
let tasks = [];
let reports = [];
let defectReports = [];
let users = [];
let fitters = [];
let overview = null;
let selectedTaskId = null;
const initialInboxParams = new URLSearchParams(window.location.search);
let selectedFolderTaskId = initialInboxParams.get('task') || null;
const requestedInboxReportId = initialInboxParams.get('report') || null;
let unreadNotifications = 0;
let unreadDefectNotifications = 0;
const folderSeenRequests = new Set();
const issuedPasswords = Object.create(null);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function localDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function formatDate(value) {
  if (!value) return 'Дата не указана';
  const parts = String(value).slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || !parts[0]) return value;
  return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}
function statusBadge(status) {
  return `<span class="wf-status ${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status || '—')}</span>`;
}
function formatHouseCount(count) {
  const n = Math.abs(Number(count) || 0);
  const lastTwo = n % 100;
  const last = n % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${n} домов`;
  if (last === 1) return `${n} дом`;
  if (last >= 2 && last <= 4) return `${n} дома`;
  return `${n} домов`;
}
function message(text, isError = false) {
  const el = $('globalMessage');
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('error', isError);
  if (text) window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function api(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json().catch(() => ({})) : {};
  if (response.status === 401 && url !== '/api/auth/me') {
    window.location.replace('/login.html');
    throw new Error('Сессия завершена. Войди снова.');
  }
  if (!response.ok) throw new Error(data.error || `Ошибка сервера (${response.status})`);
  return data;
}
function roleCanManage() { return ['supervisor', 'developer'].includes(currentUser?.role); }
function roleCanAssignTasks() { return ['receiver', 'supervisor', 'developer'].includes(currentUser?.role); }
function roleCanReview() { return ['receiver', 'supervisor', 'developer'].includes(currentUser?.role); }
function roleIsDeveloper() { return currentUser?.role === 'developer'; }
function roleCanCreateUsers() { return ['supervisor', 'developer'].includes(currentUser?.role); }

function configurePanels() {
  const role = currentUser.role;
  $('currentUserName').textContent = currentUser.displayName;
  $('currentUserRole').textContent = `${roleLabels[role] || role} · ${currentUser.username}`;
  $('todayLabel').textContent = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  document.querySelectorAll('[data-global-role]').forEach(link => {
    const access = link.dataset.globalRole;
    const visible = access === 'manager' ? role !== 'fitter'
      : access === 'office' ? role !== 'fitter'
        : access === 'developer' ? roleIsDeveloper()
          : true;
    link.hidden = !visible;
  });
  $('pageHeading').textContent = role === 'fitter' ? 'Мой рабочий день' : role === 'receiver' ? 'Приёмка и планирование' : role === 'supervisor' ? 'Управление бригадой' : 'Панель разработчика';
  $('pageSubheading').textContent = role === 'fitter'
    ? 'План выездов, отметки по дому, ручные эскизы и фотографии дефектов.'
    : role === 'receiver' ? 'Распределяй дома между слесарями, проверяй схемы CAD и фотографии дефектов подъездов.'
      : role === 'supervisor' ? 'Распределяй улицы и дома между слесарями, контролируй отметки по этапам и создавай аккаунты.'
        : 'Полный доступ к ролям, заданиям, отчётам, тестированию и настройкам.';
  const tabs = [];
  if (role === 'fitter') tabs.push(['myTasksSection', 'Мои задания']);
  if (roleCanAssignTasks()) tabs.push(['scheduleSection', 'План работ']);
  if (roleCanManage()) tabs.push(['overviewSection', 'Контроль команды']);
  if (roleCanReview()) tabs.push(['inboxSection', 'Уведомления']);
  if (roleCanCreateUsers()) tabs.push(['usersSection', roleIsDeveloper() ? 'Аккаунты и тесты' : 'Создать аккаунты'], ['credentialsSection', 'База аккаунтов']);
  $('workspaceNav').innerHTML = tabs.map(([id, label], index) => `<button type="button" data-target="${id}" class="${index === 0 ? 'active' : ''}"><span>${label}</span>${id === 'inboxSection' && unreadNotifications ? ` <span class="wf-nav-count">${unreadNotifications}</span>` : ''}</button>`).join('');
  document.querySelectorAll('.wf-section').forEach(section => { section.hidden = true; });
  if (tabs.length) $(tabs[0][0]).hidden = false;
  $('workspaceNav').querySelectorAll('[data-target]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.wf-section').forEach(section => { section.hidden = section.id !== button.dataset.target; });
    $('workspaceNav').querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
  }));
  if ($('runDiagnosticsBtn')) $('runDiagnosticsBtn').closest('.wf-dev-tools').hidden = !roleIsDeveloper();
  if ($('accountAccessTag')) $('accountAccessTag').textContent = roleIsDeveloper() ? 'Полный доступ разработчика' : 'Доступ руководителя';
  if ($('newUserRole')) $('newUserRole').innerHTML = roleIsDeveloper()
    ? '<option value="fitter">Слесарь</option><option value="receiver">Приёмщик</option><option value="supervisor">Руководитель</option><option value="developer">Разработчик</option>'
    : '<option value="fitter">Слесарь</option><option value="receiver">Приёмщик</option>';
}

async function loadTasks() {
  const data = await api('/api/workforce/tasks');
  tasks = data.tasks || [];
  renderMyTasks();
  renderSchedule();
  return tasks;
}
function renderMyTasks() {
  const root = $('myTasksList');
  if (!root) return;
  $('myTaskCount').textContent = String(tasks.length);
  if (!tasks.length) {
    root.innerHTML = '<div class="wf-empty">Пока нет назначенных работ. Когда приёмщик или руководитель распределит улицу и дома, здесь появится твой план на каждый день.</div>';
    $('taskDetail').hidden = true;
    return;
  }
  const today = localDateValue();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowValue = localDateValue(tomorrow);
  const sorted = [...tasks].sort((a, b) => String(a.scheduledDate).localeCompare(String(b.scheduledDate)) || String(a.street).localeCompare(String(b.street), 'ru') || String(a.address).localeCompare(String(b.address), 'ru', { numeric: true }));
  if (!selectedTaskId || !tasks.some(task => task.id === selectedTaskId)) {
    selectedTaskId = sorted.find(task => task.scheduledDate === today)?.id || sorted.find(task => String(task.scheduledDate) > today)?.id || sorted[0].id;
  }
  const groups = new Map();
  for (const task of sorted) {
    const key = task.scheduledDate || 'undated';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  const dateRank = date => date === today ? 0 : date === tomorrowValue ? 1 : date === 'undated' ? 4 : date > today ? 2 : 3;
  const orderedGroups = [...groups.entries()].sort((a, b) => dateRank(a[0]) - dateRank(b[0]) || String(a[0]).localeCompare(String(b[0])));
  root.innerHTML = `${groups.has(today) ? '' : `<div class="wf-day-heading"><b>Сегодня</b><span>На сегодня назначений нет</span></div>`}${orderedGroups.map(([date, dayTasks]) => {
    const heading = date === today ? 'Сегодня' : date === tomorrowValue ? 'Завтра' : date === 'undated' ? 'Дата не указана' : date < today ? `Просрочено · ${formatDate(date)}` : formatDate(date);
    const houses = dayTasks.length === 1 ? '1 дом' : `${dayTasks.length} домов`;
    const items = dayTasks.map(task => `
      <button type="button" class="wf-task-item ${task.id === selectedTaskId ? 'selected' : ''}" data-task-id="${escapeHtml(task.id)}">
        <span class="wf-item-top"><b class="wf-item-title">${escapeHtml(task.title)}</b>${statusBadge(task.status)}</span>
        <span class="wf-item-meta">${escapeHtml(task.street)}, дом ${escapeHtml(task.address)}<br>Схем: ${escapeHtml(task.reportsCount || 0)} · отчётов о дефектах: ${escapeHtml(task.defectReportsCount || 0)}</span>
      </button>`).join('');
    return `<div class="wf-day-group"><div class="wf-day-heading"><b>${escapeHtml(heading)}</b><span>${escapeHtml(houses)}</span></div>${items}</div>`;
  }).join('')}`;
  root.querySelectorAll('[data-task-id]').forEach(button => button.addEventListener('click', () => {
    selectedTaskId = button.dataset.taskId;
    renderMyTasks();
  }));
  renderTaskDetail();
}
function renderTaskDetail() {
  const task = tasks.find(item => item.id === selectedTaskId);
  const root = $('taskDetail');
  if (!task || !root) { if (root) root.hidden = true; return; }
  root.hidden = false;
  const events = (task.events || []).map(event => `<li><b>${escapeHtml(event.label)}</b><small>${escapeHtml(formatDateTime(event.at))}</small></li>`).join('');
  let action = '';
  if (task.status === 'assigned' || task.status === 'revision_requested') action = '<button class="wf-button wf-button-primary" id="startTaskBtn" type="button">Начать обход дома</button>';
  else if (task.status === 'in_progress') action = '<button class="wf-button wf-button-primary" id="visitTaskBtn" type="button">Отметить: прошёл этот дом</button>';
  else if (task.status === 'house_visited') action = '<button class="wf-button wf-button-primary" id="officeTaskBtn" type="button">Отметить: пришёл в офис</button>';
  else if (task.status === 'at_office') action = `
    <form class="wf-form" id="fieldReportForm">
      <div class="wf-card-head"><h3>Отправка ручной схемы</h3><span class="wf-tag">Для CAD</span></div>
      <label>Ручной эскиз, нарисованный на бумаге<input type="file" name="sketch" accept="image/jpeg,image/png,image/webp,image/tiff,image/heic,image/heif" required></label>
      <label>Комментарий (необязательно)<textarea name="note" rows="2" maxlength="1800" placeholder="Короткое пояснение к схеме…"></textarea></label>
      <div class="wf-footnote">Ручной эскиз автоматически преобразуется в CAD. Фотографии дефектов отправляются отдельно и не запускают CAD.</div>
      <button class="wf-button wf-button-primary" type="submit">Отправить ручной эскиз</button>
      <div class="wf-form-status" id="reportFormStatus"></div>
    </form>`;
  const defectForm = task.officeAt ? `
    <form class="wf-form wf-defect-upload" id="fieldDefectForm">
      <div class="wf-card-head"><h3>Фотографии дефектов в подъезде</h3><span class="wf-tag wf-tag-blue">Отдельно от CAD</span></div>
      <label>Фотографии найденных дефектов<input type="file" name="defectPhotos" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple required></label>
      <label>Описание дефектов (необязательно)<textarea name="note" rows="2" maxlength="1200" placeholder="Подъезд, этаж, место и что именно повреждено…"></textarea></label>
      <div class="wf-footnote">Можно прикрепить до 10 фотографий. Они поступят приёмщику отдельным уведомлением и не преобразуются в CAD.</div>
      <button class="wf-button wf-button-primary" type="submit">Отправить фотографии дефектов приёмщику</button>
      <div class="wf-form-status" id="defectFormStatus"></div>
    </form>` : '';
  const previousDefects = (task.defectReports || []).map(report => `<div class="wf-defect-history-item"><span>${escapeHtml(formatDateTime(report.submittedAt))} · ${Number(report.photos?.length || 0)} фото</span>${statusBadge(report.status)}${report.reviewComment ? `<small>${escapeHtml(report.reviewComment)}</small>` : ''}</div>`).join('');
  root.innerHTML = `
    <div class="wf-card-head"><h3>${escapeHtml(task.title)}</h3>${statusBadge(task.status)}</div>
    <p><b>${escapeHtml(formatDate(task.scheduledDate))}</b> · ${escapeHtml(task.street)}, дом ${escapeHtml(task.address)}</p>
    ${task.instructions ? `<div class="wf-instructions">${escapeHtml(task.instructions)}</div>` : '<p>Дополнительных инструкций нет.</p>'}
    <div class="wf-track-panel"><h4>Трекер этапов</h4><ol class="wf-event-list">${events || '<li>Отметок пока нет</li>'}</ol></div>
    ${task.status === 'submitted' || task.status === 'processing' ? '<div class="wf-message">Ручной эскиз отправлен. Выполняется автоматическое преобразование в CAD.</div>' : ''}
    ${task.status === 'pending_review' ? '<div class="wf-message">CAD-схема готова и появилась в уведомлениях приёмщика.</div>' : ''}
    ${task.status === 'accepted' ? '<div class="wf-message">Схема принята приёмщиком.</div>' : ''}
    ${task.status === 'revision_requested' ? `<div class="wf-message error">Схему вернули на исправление. ${task.lastReviewComment ? `<br><b>Комментарий:</b> ${escapeHtml(task.lastReviewComment)}` : 'Выполни обход повторно и отправь исправленный эскиз.'}</div>` : ''}
    ${action}
    ${defectForm}
    ${previousDefects ? `<div class="wf-defect-history"><h4>Отправленные фотографии дефектов</h4>${previousDefects}</div>` : ''}`;
  const runTaskAction = async (button, endpoint, label) => {
    button.disabled = true; button.textContent = 'Сохраняю отметку…';
    try {
      await api(`/api/workforce/tasks/${encodeURIComponent(task.id)}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      message(label);
      await Promise.all([loadTasks(), roleCanAssignTasks() ? loadOverview() : Promise.resolve()]);
    } catch (error) { message(error.message, true); button.disabled = false; }
  };
  $('startTaskBtn')?.addEventListener('click', event => runTaskAction(event.currentTarget, 'start', 'Отметка «Начал обход дома» сохранена.'));
  $('visitTaskBtn')?.addEventListener('click', event => runTaskAction(event.currentTarget, 'visit', 'Зафиксировано: дом пройден.'));
  $('officeTaskBtn')?.addEventListener('click', event => runTaskAction(event.currentTarget, 'office', 'Зафиксировано: сотрудник пришёл в офис.'));
  const form = $('fieldReportForm');
  if (form) form.addEventListener('submit', async event => {
    event.preventDefault();
    const status = $('reportFormStatus');
    const submit = form.querySelector('button[type="submit"]');
    const data = new FormData(form);
    if (!form.elements.sketch.files.length) { status.textContent = 'Прикрепи файл ручного эскиза.'; return; }
    submit.disabled = true; status.textContent = 'Отправляю эскиз в автоматическую обработку…';
    try {
      const result = await api(`/api/workforce/tasks/${encodeURIComponent(task.id)}/report`, { method: 'POST', body: data });
      status.textContent = `Эскиз отправлен ${formatDateTime(result.report?.submittedAt)}. CAD-обработка поставлена в очередь.`;
      message('Ручной эскиз отправлен. У приёмщика появится уведомление с адресом.');
      await loadTasks();
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  const defectFormElement = $('fieldDefectForm');
  if (defectFormElement) defectFormElement.addEventListener('submit', async event => {
    event.preventDefault();
    const status = $('defectFormStatus');
    const submit = defectFormElement.querySelector('button[type="submit"]');
    const files = defectFormElement.elements.defectPhotos.files;
    if (!files.length) { status.textContent = 'Добавь хотя бы одну фотографию дефекта.'; return; }
    if (files.length > 10) { status.textContent = 'Можно отправить не более 10 фотографий за один раз.'; return; }
    const data = new FormData(defectFormElement);
    submit.disabled = true; status.textContent = 'Отправляю фотографии приёмщику…';
    try {
      const result = await api(`/api/workforce/tasks/${encodeURIComponent(task.id)}/defects`, { method: 'POST', body: data });
      status.textContent = `Отправлено фотографий: ${result.report?.photos?.length || files.length}. Ожидает проверки приёмщиком.`;
      message('Фотографии дефектов отправлены приёмщику отдельным уведомлением.');
      await loadTasks();
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; }
  });
}

function renderSchedule() {
  const root = $('scheduleList');
  if (!root) return;
  $('scheduleCount').textContent = String(tasks.length);
  const sorted = [...tasks].sort((a, b) => String(a.scheduledDate).localeCompare(String(b.scheduledDate)) || String(a.assignedName).localeCompare(String(b.assignedName), 'ru') || String(a.street).localeCompare(String(b.street), 'ru') || String(a.address).localeCompare(String(b.address), 'ru', { numeric: true }));
  const groups = new Map();
  for (const task of sorted) {
    const key = task.assignmentGroupId || task.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  root.innerHTML = groups.size ? [...groups.values()].map(group => {
    const first = group[0];
    const houses = group.map(task => `<li><span>Дом ${escapeHtml(task.address)}</span>${statusBadge(task.status)}</li>`).join('');
    const countLabel = formatHouseCount(group.length);
    return `<article class="wf-dispatch-group"><div class="wf-item-top"><b class="wf-item-title">${escapeHtml(first.title)}</b><span class="wf-tag">${countLabel}</span></div><div class="wf-item-meta">${escapeHtml(formatDate(first.scheduledDate))} · ${escapeHtml(first.street)}<br>Слесарь: ${escapeHtml(first.assignedName || '—')}</div><ul class="wf-house-list">${houses}</ul></article>`;
  }).join('') : '<div class="wf-empty">Назначений ещё нет. Добавь улицу и перечисли дома в форме слева.</div>';
}

async function loadOverview() {
  const data = await api('/api/workforce/overview');
  overview = data;
  if (roleCanAssignTasks()) {
    fitters = (data.users || []).filter(user => user.role === 'fitter');
    const select = $('fitterSelect');
    if (select) select.innerHTML = fitters.length
      ? `<option value="">Выбери слесаря</option>${fitters.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.displayName)} · ${escapeHtml(user.username)}</option>`).join('')}`
      : '<option value="">Сначала создай аккаунт слесаря</option>';
    if (roleCanManage()) renderOverview(data);
  }
  return data;
}
function renderOverview(data) {
  if (!data) return;
  const summary = data.summary || {};
  $('overviewStats').innerHTML = [
    ['Активных слесарей', summary.activeFitters || 0],
    ['Назначено / обход', summary.assigned || 0],
    ['Эскизов отправлено', summary.submitted || 0],
    ['Ожидают приёмки схем', summary.pendingReports || 0],
    ['Дефектов на проверке', summary.pendingDefects || 0]
  ].map(([label, value]) => `<div class="wf-stat"><span>${escapeHtml(label)}</span><b>${Number(value)}</b></div>`).join('');
  const fitters = (data.users || []).filter(user => user.role === 'fitter');
  $('workerLocations').innerHTML = fitters.length ? fitters.map(user => {
    const task = user.activeTask;
    const latest = task?.events?.at(-1);
    return `<article class="wf-worker">
      <div class="wf-worker-head"><b>${escapeHtml(user.displayName)}</b><span class="wf-status ${task ? escapeHtml(task.status) : ''}">${task ? escapeHtml(statusLabels[task.status] || task.status) : 'Нет активного задания'}</span></div>
      <small>Логин: ${escapeHtml(user.username)}<br>Назначений: ${Number(user.assignedTasks || 0)}</small>
      ${task ? `<div class="wf-worker-current"><b>${escapeHtml(task.street)}, дом ${escapeHtml(task.address)}</b><small>${escapeHtml(task.title)} · ${escapeHtml(formatDate(task.scheduledDate))}</small>${latest ? `<small>Последняя отметка: ${escapeHtml(latest.label)}<br>${escapeHtml(formatDateTime(latest.at))}</small>` : '<small>Слесарь ещё не начал обход.</small>'}</div>` : '<small>Нет незавершённых назначений.</small>'}
    </article>`;
  }).join('') : '<div class="wf-empty">Аккаунты слесарей пока не созданы.</div>';
  $('locationUpdatedLabel').textContent = `Обновлено: ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

function updateNotificationBadge() {
  const button = $('workspaceNav')?.querySelector('[data-target="inboxSection"]');
  const totalUnread = unreadNotifications + unreadDefectNotifications;
  if (button) button.innerHTML = `Уведомления${totalUnread ? ` <span class="wf-nav-count">${totalUnread}</span>` : ''}`;
  const folderCount = buildInboxFolders().length;
  if ($('inboxItemCount')) $('inboxItemCount').textContent = `${folderCount} папок по адресам`;
  if ($('inboxListCount')) $('inboxListCount').textContent = String(folderCount);
}
async function loadReports() {
  if (!roleCanReview()) return;
  const data = await api('/api/workforce/reports');
  reports = data.reports || [];
  unreadNotifications = Number(data.unreadCount ?? reports.filter(report => !report.seen).length);
  renderUnifiedInbox();
  updateNotificationBadge();
  return reports;
}
async function loadDefectReports() {
  if (!roleCanReview()) return;
  const data = await api('/api/workforce/defects');
  defectReports = data.reports || [];
  unreadDefectNotifications = Number(data.unreadCount ?? defectReports.filter(report => !report.seen).length);
  renderUnifiedInbox();
  updateNotificationBadge();
  return defectReports;
}
function renderReports() { renderUnifiedInbox(); }
function renderDefectReports() { renderUnifiedInbox(); }
function buildInboxFolders() {
  const map = new Map();
  const ensure = item => {
    if (!item?.taskId) return null;
    if (!map.has(item.taskId)) {
      map.set(item.taskId, {
        taskId: item.taskId, street: item.street || '', address: item.address || '',
        taskTitle: item.taskTitle || 'Задание', scheduledDate: item.scheduledDate || null,
        assignedName: item.assignedName || item.userName || 'Слесарь',
        schemes: [], defects: [], latestAt: item.submittedAt || null
      });
    }
    const folder = map.get(item.taskId);
    if (!folder.street && item.street) folder.street = item.street;
    if (!folder.address && item.address) folder.address = item.address;
    if (!folder.scheduledDate && item.scheduledDate) folder.scheduledDate = item.scheduledDate;
    if (item.submittedAt && (!folder.latestAt || new Date(item.submittedAt) > new Date(folder.latestAt))) folder.latestAt = item.submittedAt;
    return folder;
  };
  for (const report of reports) {
    if (report.status === 'superseded') continue;
    const folder = ensure(report);
    if (folder) folder.schemes.push(report);
  }
  for (const report of defectReports) {
    if (report.status === 'superseded') continue;
    const folder = ensure(report);
    if (folder) folder.defects.push(report);
  }
  return [...map.values()].map(folder => {
    folder.schemes.sort((a, b) => new Date(a.submittedAt || 0) - new Date(b.submittedAt || 0));
    folder.defects.sort((a, b) => new Date(a.submittedAt || 0) - new Date(b.submittedAt || 0));
    folder.materialCount = folder.schemes.length + folder.defects.length;
    folder.unreadCount = [...folder.schemes, ...folder.defects].filter(item => !item.seen).length;
    folder.photoCount = folder.defects.reduce((sum, item) => sum + Number(item.photos?.length || 0), 0);
    return folder;
  }).sort((a, b) => new Date(b.latestAt || 0) - new Date(a.latestAt || 0));
}
function folderReadiness(folder) {
  const items = [...folder.schemes, ...folder.defects];
  const allAccepted = items.length > 0 && items.every(item => item.status === 'accepted');
  const schemesReady = folder.schemes.every(report => report.schemeJobId && (
    report.schemeStatus === 'completed' || (report.schemeStatus === 'failed' && report.schemePartialGraphReady)
  ));
  const photosReady = folder.defects.every(report => Array.isArray(report.photos) && report.photos.length > 0);
  const allSeen = items.every(item => item.seen);
  const allAdded = items.length > 0 && items.every(item => Boolean(item.conclusionAddedAt));
  const addedCount = items.filter(item => item.conclusionAddedAt).length;
  return {
    items, allAccepted, schemesReady, photosReady, allSeen, allAdded,
    ready: allAccepted && schemesReady && photosReady && allSeen,
    addedCount, waitingCount: items.filter(item => item.status !== 'accepted').length
  };
}
function renderUnifiedInbox() {
  const listRoot = $('reportList');
  const detailRoot = $('reportDetail');
  if (!listRoot || !detailRoot) return;
  const folders = buildInboxFolders();
  const filter = String($('inboxStreetFilter')?.value || '').trim().toLocaleLowerCase('ru-RU');
  if (!selectedFolderTaskId && requestedInboxReportId) {
    const match = folders.find(folder => folder.schemes.some(report => report.id === requestedInboxReportId));
    if (match) selectedFolderTaskId = match.taskId;
  }
  const visible = folders.filter(folder => !filter || [
    folder.street, folder.address, folder.assignedName, folder.taskTitle,
    ...folder.schemes.map(report => `${report.userName || ''} ${report.note || ''}`),
    ...folder.defects.map(report => `${report.userName || ''} ${report.note || ''}`)
  ].join(' ').toLocaleLowerCase('ru-RU').includes(filter));
  if ($('inboxItemCount')) $('inboxItemCount').textContent = `${folders.length} папок по адресам`;
  if ($('inboxListCount')) $('inboxListCount').textContent = String(visible.length);
  if (!visible.some(folder => folder.taskId === selectedFolderTaskId)) selectedFolderTaskId = visible[0]?.taskId || null;
  listRoot.innerHTML = visible.length ? visible.map(folder => {
    const state = folderReadiness(folder);
    const selected = folder.taskId === selectedFolderTaskId;
    const status = state.allAdded ? 'В заключении' : state.ready ? 'Готова к заключению' : state.waitingCount ? 'Проверка материалов' : 'Ожидает CAD';
    const countLabel = [
      folder.schemes.length ? `${folder.schemes.length} схем` : '',
      folder.defects.length ? `${folder.defects.length} отчётов о дефектах · ${folder.photoCount} фото` : ''
    ].filter(Boolean).join(' · ');
    return `<button class="wf-report-item wf-folder-item ${selected ? 'selected' : ''}" type="button" data-inbox-folder="${escapeHtml(folder.taskId)}">
      <span class="wf-item-top"><b class="wf-item-title">📁 ${escapeHtml(folder.street)}, д. ${escapeHtml(folder.address)}</b>${statusBadge(state.allAdded ? 'accepted' : state.ready ? 'pending_review' : state.waitingCount ? 'processing' : 'pending_review')}</span>
      <span class="wf-item-meta"><b>${escapeHtml(countLabel || 'Материалы')}</b><br>${escapeHtml(folder.assignedName)} · ${escapeHtml(formatDate(folder.scheduledDate))}<br>${escapeHtml(status)}${folder.unreadCount ? `<br><b>Новых материалов: ${folder.unreadCount}</b>` : ''}${state.allAdded ? '<br><b>Вся папка добавлена в заключение</b>' : ''}</span>
    </button>`;
  }).join('') : `<div class="wf-empty">${folders.length ? 'По этому адресу ничего не найдено.' : 'Папок пока нет. Когда слесарь отправит схему или фотографии дефектов по назначенному дому, здесь появится папка адреса.'}</div>`;
  listRoot.querySelectorAll('[data-inbox-folder]').forEach(button => button.addEventListener('click', () => {
    selectedFolderTaskId = button.dataset.inboxFolder;
    renderUnifiedInbox();
  }));
  const selectedFolder = visible.find(folder => folder.taskId === selectedFolderTaskId);
  if (!selectedFolder) {
    detailRoot.innerHTML = '<div class="wf-empty">Выбери папку адреса слева. Внутри будут все отправленные по этому дому схемы и фотографии дефектов.</div>';
    return;
  }
  renderInboxFolderDetail(selectedFolder);
}
async function markInboxFolderSeen(folder) {
  if (folderSeenRequests.has(folder.taskId)) return;
  const unseenSchemes = folder.schemes.filter(item => !item.seen);
  const unseenDefects = folder.defects.filter(item => !item.seen);
  if (!unseenSchemes.length && !unseenDefects.length) return;
  folderSeenRequests.add(folder.taskId);
  try {
    await Promise.all([
      ...unseenSchemes.map(item => api(`/api/workforce/reports/${encodeURIComponent(item.id)}/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => { item.seen = true; })),
      ...unseenDefects.map(item => api(`/api/workforce/defects/${encodeURIComponent(item.id)}/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => { item.seen = true; }))
    ]);
    unreadNotifications = reports.filter(item => !item.seen && item.status !== 'superseded').length;
    unreadDefectNotifications = defectReports.filter(item => !item.seen && item.status !== 'superseded').length;
    updateNotificationBadge();
    renderUnifiedInbox();
  } catch (error) {
    message(`Не удалось отметить всю папку просмотренной: ${error.message}`, true);
  } finally {
    folderSeenRequests.delete(folder.taskId);
  }
}
function renderInboxFolderDetail(folder) {
  const root = $('reportDetail');
  if (!root) return;
  const state = folderReadiness(folder);
  const latestUser = [...folder.schemes, ...folder.defects].at(-1)?.userName || folder.assignedName;
  const schemeCards = folder.schemes.map((report, index) => {
    const partialCadReady = report.schemeStatus === 'failed' && report.schemePartialGraphReady;
    const cadReady = report.schemeStatus === 'completed' || partialCadReady;
    const schemeStatus = cadReady ? report.status : 'processing';
    const preview = cadReady && report.schemeJobId
      ? `<div class="wf-cad-preview"><div class="wf-file-label">${partialCadReady ? 'Частичный CAD-результат — требуется проверка' : 'Автоматически построенная CAD-схема'}</div><img src="/jobs/${encodeURIComponent(report.schemeJobId)}/clean.svg" alt="CAD-схема ${escapeHtml(folder.street)}, дом ${escapeHtml(folder.address)}" loading="lazy"><small>Открой редактор, чтобы проверить геометрию и сохранить исправления.</small></div>`
      : `<div class="wf-message ${report.schemeStatus === 'failed' ? 'error' : ''}">${report.schemeStatus === 'failed' ? `CAD-обработка завершилась ошибкой: ${escapeHtml(report.schemeError || 'Неизвестная ошибка')}` : `CAD-обработка: ${escapeHtml(report.schemeStatus || 'в очереди')}.`}</div>`;
    const sketch = report.sketch ? `<a class="wf-attachment" href="${escapeHtml(report.sketch.url)}" target="_blank" rel="noopener">Открыть ручной эскиз: ${escapeHtml(report.sketch.originalName)}</a>` : '<span class="wf-muted">Ручной эскиз не найден.</span>';
    const review = report.status === 'pending_review'
      ? `<label class="wf-file-label" for="scheme-comment-${escapeHtml(report.id)}">Комментарий приёмщика (необязательно)</label><textarea class="wf-review-comment" id="scheme-comment-${escapeHtml(report.id)}" rows="2" maxlength="1200" placeholder="Замечания к схеме…"></textarea><div class="wf-review-actions"><button class="wf-button wf-button-outline" type="button" data-accept-scheme="${escapeHtml(report.id)}">Принять схему</button><button class="wf-button wf-button-outline" type="button" data-return-scheme="${escapeHtml(report.id)}">Вернуть на исправление</button></div>`
      : report.status === 'revision_requested'
        ? `<p class="wf-message error">Возвращено на исправление. ${escapeHtml(report.reviewComment || '')}</p>`
        : `<p class="wf-footnote">Решение: ${escapeHtml(statusLabels[report.status] || report.status)} · ${escapeHtml(formatDateTime(report.reviewedAt))}${report.reviewComment ? `<br>${escapeHtml(report.reviewComment)}` : ''}</p>`;
    const disabled = !report.seen ? 'disabled' : '';
    const cadButton = cadReady
      ? `<button class="wf-button wf-button-outline" type="button" data-open-folder-cad="${escapeHtml(report.id)}">Открыть и редактировать CAD →</button>`
      : '';
    return `<article class="wf-folder-material"><div class="wf-folder-material-head"><h4>Схема ${index + 1}</h4>${statusBadge(schemeStatus)}</div><p class="wf-item-meta">Слесарь: ${escapeHtml(report.userName)} · ${escapeHtml(formatDateTime(report.submittedAt))}</p>${report.note ? `<div class="wf-report-note">${escapeHtml(report.note)}</div>` : ''}<div class="wf-file-label">Исходный эскиз</div>${sketch}${preview}${cadButton}${review.replaceAll('<button ', `<button ${disabled} `)}</article>`;
  }).join('');
  const defectCards = folder.defects.map((report, index) => {
    const photos = (report.photos || []).map(photo => {
      const browserPreview = /^image\/(?:jpeg|png|webp|gif|avif)$/i.test(photo.mimeType || '');
      const preview = browserPreview
        ? `<img src="${escapeHtml(photo.url)}" alt="Дефект: ${escapeHtml(photo.originalName)}" loading="lazy">`
        : `<div class="wf-attachment-file"><b>ФОТОФАЙЛ</b><small>${escapeHtml((photo.mimeType || 'исходный формат').replace(/^image\//i, '').toUpperCase())}</small><span>Открыть оригинал →</span></div>`;
      return `<a class="wf-attachment" href="${escapeHtml(photo.url)}" target="_blank" rel="noopener">${preview}<span>${escapeHtml(photo.originalName)}</span></a>`;
    }).join('');
    const approval = report.status === 'accepted'
      ? '<div class="wf-defect-approved"><span aria-hidden="true">✓</span> Фотографии подходят</div>'
      : report.status === 'pending_review' || report.status === 'revision_requested'
        ? `<label class="wf-defect-approve"><input type="checkbox" id="approve-defect-${escapeHtml(report.id)}" data-accept-defect="${escapeHtml(report.id)}" ${report.seen ? '' : 'disabled'}><span>Да, фотографии подходят</span></label>` : '';
    const returnAction = report.status === 'pending_review'
      ? `<label class="wf-file-label" for="defect-comment-${escapeHtml(report.id)}">Комментарий (необязательно)</label><textarea class="wf-review-comment" id="defect-comment-${escapeHtml(report.id)}" rows="2" maxlength="1200" placeholder="Что нужно переснять или уточнить…"></textarea><button class="wf-button wf-button-outline" type="button" data-return-defect="${escapeHtml(report.id)}" ${report.seen ? '' : 'disabled'}>Вернуть на исправление</button>` : '';
    return `<article class="wf-folder-material"><div class="wf-folder-material-head"><h4>Дефекты · комплект ${index + 1}</h4>${statusBadge(report.status)}</div><p class="wf-item-meta">Слесарь: ${escapeHtml(report.userName)} · ${escapeHtml(formatDateTime(report.submittedAt))}</p>${report.note ? `<div class="wf-report-note">${escapeHtml(report.note)}</div>` : ''}<div class="wf-attachment-grid wf-defect-photo-grid">${photos || '<span class="wf-muted">Фотографии не найдены.</span>'}</div>${approval}${report.status === 'accepted' ? `<p class="wf-footnote">Подтверждено: ${escapeHtml(formatDateTime(report.reviewedAt))}${report.reviewedByName ? ` · ${escapeHtml(report.reviewedByName)}` : ''}</p>` : ''}${report.status === 'revision_requested' ? `<p class="wf-message error">Возвращено: ${escapeHtml(report.reviewComment || '')}</p>` : ''}${returnAction}</article>`;
  }).join('');
  const allAdded = state.allAdded;
  const footer = allAdded
    ? `<div class="wf-message">Вся папка уже добавлена в заключение.</div><a class="wf-button wf-button-outline" href="/conclusion.html?task=${encodeURIComponent(folder.taskId)}">Открыть заключение по этому дому →</a>`
    : state.ready
      ? `<div class="wf-message">Все материалы просмотрены и приняты. Будут добавлены ${folder.schemes.length} схем и ${folder.defects.length} комплектов фотографий (${folder.photoCount} фото).</div><button class="wf-button wf-button-primary" id="addFolderToConclusionBtn" type="button">Добавить всю папку в заключение →</button>`
      : `<button class="wf-button wf-button-primary" type="button" disabled>Добавить всю папку в заключение</button><p class="wf-footnote">Перенос станет доступен, когда все схемы будут проверены и приняты, CAD-обработка завершится, а все комплекты фотографий дефектов получат подтверждение. ${state.waitingCount ? `Ожидают решения: ${state.waitingCount}.` : ''}${!state.allSeen ? ' Папка ещё отмечается как просмотренная.' : ''}${!state.schemesReady ? ' Есть схемы, которые ещё обрабатываются.' : ''}</p>`;
  root.innerHTML = `
    <div class="wf-card-head"><div><p class="wf-eyebrow">ПАПКА АДРЕСА</p><h3>${escapeHtml(folder.street)}, дом ${escapeHtml(folder.address)}</h3></div>${statusBadge(allAdded ? 'accepted' : state.ready ? 'pending_review' : 'processing')}</div>
    <p class="wf-item-meta">${escapeHtml(folder.taskTitle)} · ${escapeHtml(formatDate(folder.scheduledDate))}<br>Слесарь: ${escapeHtml(folder.assignedName || latestUser)}<br>Схем: ${folder.schemes.length} · Комплектов дефектов: ${folder.defects.length} · Фотографий: ${folder.photoCount}</p>
    ${folder.schemes.length ? `<section class="wf-folder-group"><h4>Ручные схемы и CAD</h4>${schemeCards}</section>` : '<div class="wf-empty">По этому дому слесарь ещё не отправлял ручные схемы.</div>'}
    ${folder.defects.length ? `<section class="wf-folder-group"><h4>Фотографии дефектов подъезда</h4>${defectCards}</section>` : '<div class="wf-empty">Фотографии дефектов по этому дому ещё не отправлены.</div>'}
    <div class="wf-folder-transfer"><h4>Передача материалов в заключение</h4>${footer}</div>`;

  root.querySelectorAll('[data-open-folder-cad]').forEach(button => button.addEventListener('click', async () => {
    const report = folder.schemes.find(item => item.id === button.dataset.openFolderCad);
    if (!report) return;
    button.disabled = true; button.textContent = 'Открываю CAD…';
    try {
      if (report.manualCadProjectId) {
        window.location.href = `/manual-cad.html?project=${encodeURIComponent(report.manualCadProjectId)}`;
        return;
      }
      const data = await api(`/api/manual-cad/import-job/${encodeURIComponent(report.schemeJobId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `${report.street}, дом ${report.address}` }) });
      if (!data.project?.id) throw new Error('Сервер не вернул CAD-проект.');
      window.location.href = data.project.editUrl || `/manual-cad.html?project=${encodeURIComponent(data.project.id)}`;
    } catch (error) { message(error.message, true); button.disabled = false; button.textContent = 'Повторить открытие CAD →'; }
  }));
  root.querySelectorAll('[data-accept-scheme],[data-return-scheme]').forEach(button => button.addEventListener('click', async () => {
    const reportId = button.dataset.acceptScheme || button.dataset.returnScheme;
    const isAccept = Boolean(button.dataset.acceptScheme);
    const comment = $(`scheme-comment-${reportId}`)?.value || '';
    button.disabled = true;
    try {
      await api(`/api/workforce/reports/${encodeURIComponent(reportId)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: isAccept ? 'accepted' : 'revision_requested', comment }) });
      message(isAccept ? 'Схема принята.' : 'Схема возвращена на исправление.');
      await Promise.all([loadReports(), loadTasks()]);
    } catch (error) { message(error.message, true); button.disabled = false; }
  }));
  root.querySelectorAll('[data-accept-defect]').forEach(checkbox => checkbox.addEventListener('change', async event => {
    if (!event.currentTarget.checked) return;
    event.currentTarget.disabled = true;
    try {
      await api(`/api/workforce/defects/${encodeURIComponent(event.currentTarget.dataset.acceptDefect)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'accepted' }) });
      message('Комплект фотографий дефектов принят.');
      await loadDefectReports();
    } catch (error) { event.currentTarget.checked = false; event.currentTarget.disabled = false; message(error.message, true); }
  }));
  root.querySelectorAll('[data-return-defect]').forEach(button => button.addEventListener('click', async () => {
    const reportId = button.dataset.returnDefect;
    button.disabled = true;
    try {
      await api(`/api/workforce/defects/${encodeURIComponent(reportId)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'revision_requested', comment: $(`defect-comment-${reportId}`)?.value || '' }) });
      message('Комплект фотографий возвращён слесарю на исправление.');
      await loadDefectReports();
    } catch (error) { message(error.message, true); button.disabled = false; }
  }));
  $('addFolderToConclusionBtn')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = 'Собираю папку…';
    try {
      // Ensure every accepted sketch has a CAD project before the atomic folder transfer.
      await Promise.all(folder.schemes.map(async report => {
        if (!report.schemeJobId) throw new Error(`Для схемы ${report.street}, дом ${report.address} нет задания CAD.`);
        if (report.manualCadProjectId) return;
        const data = await api(`/api/manual-cad/import-job/${encodeURIComponent(report.schemeJobId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `${report.street}, дом ${report.address}` }) });
        if (!data.project?.id) throw new Error('Не удалось подготовить одну из CAD-схем папки.');
      }));
      const data = await api(`/api/workforce/tasks/${encodeURIComponent(folder.taskId)}/conclusion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      window.location.href = data.conclusionUrl || `/conclusion.html?task=${encodeURIComponent(folder.taskId)}`;
    } catch (error) { message(error.message, true); button.disabled = false; button.textContent = 'Повторить добавление папки'; }
  });

  if (state.allSeen) return;
  markInboxFolderSeen(folder);
}
async function loadUsers() {
  if (!roleCanCreateUsers()) return;
  const data = await api('/api/workforce/users');
  users = data.users || [];
  renderUsers();
}
function renderUsers() {
  const root = $('userList');
  if (!root) return;
  $('userCount').textContent = String(users.length);
  renderCredentialDatabase();
  if (!roleIsDeveloper()) {
    root.innerHTML = users.map(user => `<article class="wf-user-item"><div class="wf-item-top"><b class="wf-item-title">${escapeHtml(user.displayName)}</b><span class="wf-status ${user.active ? 'accepted' : ''}">${user.active ? 'Активен' : 'Отключён'}</span></div><span class="wf-item-meta">${escapeHtml(roleLabels[user.role] || user.role)} · Логин: ${escapeHtml(user.username)}</span></article>`).join('') || '<div class="wf-empty">Аккаунтов слесарей и приёмщиков пока нет.</div>';
    return;
  }
  const supervisorCount = users.filter(user => user.role === 'supervisor' && user.active).length;
  const roleOptions = user => Object.entries(roleLabels).map(([value, label]) => `<option value="${value}" ${user.role === value ? 'selected' : ''}>${label}</option>`).join('');
  root.innerHTML = users.map(user => `
    <form class="wf-user-item" data-user-form="${escapeHtml(user.id)}">
      <div class="wf-item-top"><b class="wf-item-title">${escapeHtml(user.displayName)}</b><span class="wf-status ${user.active ? 'accepted' : ''}">${user.active ? 'Активен' : 'Отключён'}</span></div>
      <span class="wf-item-meta">Логин: ${escapeHtml(user.username)} · Создан: ${escapeHtml(formatDateTime(user.createdAt))}</span>
      <div class="wf-user-fields"><input name="displayName" value="${escapeHtml(user.displayName)}" aria-label="Имя пользователя"><select name="role" aria-label="Роль">${roleOptions(user)}</select><input name="password" type="password" minlength="10" maxlength="200" placeholder="Новый пароль (необязательно)" autocomplete="new-password"></div>
      <div class="wf-user-actions"><label><input type="checkbox" name="active" ${user.active ? 'checked' : ''} ${user.id === currentUser.id ? 'disabled' : ''}> Аккаунт активен</label><button class="wf-button wf-button-outline" type="submit">Сохранить</button></div>
    </form>`).join('') || '<div class="wf-empty">Пользователей пока нет.</div>';
  root.querySelectorAll('[data-user-form]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const fields = new FormData(form);
    const body = { displayName: fields.get('displayName'), role: fields.get('role'), active: fields.has('active') };
    if (fields.get('password')) body.password = fields.get('password');
    const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      await api(`/api/workforce/users/${encodeURIComponent(form.dataset.userForm)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      message('Данные аккаунта обновлены.');
      await loadUsers();
      if (roleCanManage()) await loadOverview();
    } catch (error) { message(error.message, true); button.disabled = false; }
  }));
  const option = $('newUserRole')?.querySelector('option[value="supervisor"]');
  if (option) { option.disabled = supervisorCount >= 2; option.textContent = `Руководитель${supervisorCount >= 2 ? ' · лимит 2 аккаунта' : ''}`; }
}


function renderCredentialDatabase() {
  const root = $('credentialDatabase');
  if (!root) return;
  const crew = users.filter(user => ['fitter', 'receiver'].includes(user.role))
    .sort((a, b) => String(a.lastName || '').localeCompare(String(b.lastName || ''), 'ru'));
  $('credentialCount').textContent = String(crew.length);
  if (!crew.length) {
    root.innerHTML = '<div class="wf-empty">Слесари и приёмщики ещё не созданы. Создай первый аккаунт в разделе «Создать аккаунты».</div>';
    return;
  }
  root.innerHTML = `<div class="wf-credential-table-wrap"><table class="wf-credential-table"><thead><tr><th>Имя и фамилия</th><th>Роль</th><th>Логин</th><th>Пароль</th><th>Действие</th></tr></thead><tbody>${crew.map(user => {
    const password = issuedPasswords[user.id] || '';
    const nameParts = String(user.displayName || '').trim().split(/\s+/).filter(Boolean);
    const firstName = user.firstName || nameParts[0] || '';
    const lastName = user.lastName || nameParts.slice(1).join(' ');
    return `<tr>
      <td><b>${escapeHtml(`${firstName} ${lastName}`.trim())}</b><small>${user.active ? 'Активен' : 'Отключён'}</small></td>
      <td>${escapeHtml(roleLabels[user.role] || user.role)}</td>
      <td><code>${escapeHtml(user.username)}</code></td>
      <td><code class="wf-credential-password">${password ? escapeHtml(password) : '••••••••••'}</code>${password ? `<button type="button" class="wf-copy-credential" data-copy-user="${escapeHtml(user.id)}">Скопировать</button>` : '<small>Хеш защищает текущий пароль</small>'}</td>
      <td><button type="button" class="wf-button wf-button-outline" data-reset-user="${escapeHtml(user.id)}">Выдать новый пароль</button></td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
  root.querySelectorAll('[data-reset-user]').forEach(button => button.addEventListener('click', async () => {
    const user = crew.find(item => item.id === button.dataset.resetUser);
    if (!user) return;
    if (!window.confirm(`Выдать новый пароль для ${user.displayName}? Старый пароль перестанет работать.`)) return;
    button.disabled = true;
    try {
      const result = await api(`/api/workforce/users/${encodeURIComponent(user.id)}/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      issuedPasswords[user.id] = result.credentials.password;
      message(`Для ${user.displayName} выдан новый пароль. Скопируй его из таблицы и передай сотруднику.`);
      renderCredentialDatabase();
    } catch (error) { message(error.message, true); button.disabled = false; }
  }));
  root.querySelectorAll('[data-copy-user]').forEach(button => button.addEventListener('click', async () => {
    const user = crew.find(item => item.id === button.dataset.copyUser);
    const password = issuedPasswords[user?.id];
    if (!user || !password) return;
    try {
      await navigator.clipboard.writeText(`Сотрудник: ${user.displayName}\nЛогин: ${user.username}\nПароль: ${password}`);
      message(`Логин и новый пароль для ${user.displayName} скопированы.`);
    } catch { message('Не удалось скопировать автоматически — выдели данные и скопируй вручную.', true); }
  }));
}

async function initialise() {
  try {
    const data = await api('/api/auth/me');
    currentUser = data.user;
    configurePanels();
    if ($('taskDate')) $('taskDate').value = localDateValue();
    const promises = [loadTasks()];
    if (roleCanReview()) promises.push(loadReports(), loadDefectReports());
    if (roleCanAssignTasks()) promises.push(loadOverview());
    if (roleCanCreateUsers()) promises.push(loadUsers());
    await Promise.all(promises);
  } catch (error) {
    if (error.message) message(error.message, true);
  }
}

$('logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } finally { window.location.replace('/login.html'); }
});
$('refreshTasksBtn')?.addEventListener('click', () => loadTasks().catch(error => message(error.message, true)));
$('refreshOverviewBtn')?.addEventListener('click', async () => {
  try { await Promise.all([loadTasks(), loadOverview()]); message('Данные обновлены.'); }
  catch (error) { message(error.message, true); }
});
$('refreshReportsBtn')?.addEventListener('click', () => Promise.all([loadReports(), loadDefectReports()]).then(() => message('Уведомления обновлены.')).catch(error => message(error.message, true)));
$('inboxStreetFilter')?.addEventListener('input', () => renderUnifiedInbox());
$('refreshCredentialsBtn')?.addEventListener('click', () => loadUsers().then(() => message('База сотрудников обновлена.')).catch(error => message(error.message, true)));
$('createTaskForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $('taskFormStatus');
  const button = form.querySelector('button[type="submit"]');
  const fields = new FormData(form);
  const houseCount = String(fields.get('addresses') || '').split(/[\r\n;]+/).map(value => value.trim()).filter(Boolean).length;
  if (!houseCount) { status.textContent = 'Укажи хотя бы один дом, каждый с новой строки.'; return; }
  if (houseCount > 100) { status.textContent = 'За одно назначение можно добавить не более 100 домов.'; return; }
  button.disabled = true; status.textContent = 'Сохраняю список домов и распределяю задания…';
  const body = Object.fromEntries(fields.entries());
  try {
    const result = await api('/api/workforce/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    form.reset(); $('taskDate').value = localDateValue();
    const createdCount = Number(result.createdCount || result.tasks?.length || 1);
    status.textContent = `Назначено домов: ${createdCount}. Все адреса добавлены в план слесаря.`;
    message(`Слесарю назначено ${formatHouseCount(createdCount)} на выбранную дату.`);
    await Promise.all([loadTasks(), loadOverview()]);
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
$('createUserForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = $('userFormStatus');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; status.textContent = 'Создаю аккаунт…';
  const fields = new FormData(form);
  const body = { displayName: fields.get('displayName'), role: fields.get('role'), autoGenerate: true };
  try {
    const data = await api('/api/workforce/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    form.reset();
    const credentials = data.credentials || { username: data.user.username, password: '' };
    if (credentials.password) issuedPasswords[data.user.id] = credentials.password;
    const credentialBox = $('createdCredentials');
    if (credentialBox) {
      credentialBox.hidden = false;
      credentialBox.innerHTML = `<b>Аккаунт создан. Сохраните данные сейчас:</b><div><span>Логин</span><code>${escapeHtml(credentials.username)}</code></div><div><span>Временный пароль</span><code>${escapeHtml(credentials.password)}</code></div><button type="button" class="wf-button wf-button-outline" id="copyCredentialsBtn">Скопировать логин и пароль</button>`;
      $('copyCredentialsBtn')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(`Логин: ${credentials.username}\nПароль: ${credentials.password}`); message('Данные для входа скопированы.'); }
        catch { message('Не удалось скопировать автоматически — выдели данные и скопируй вручную.', true); }
      });
    }
    status.textContent = `Создан аккаунт: ${data.user.displayName} (${data.user.roleName}).`;
    message(`Аккаунт ${data.user.username} создан. Передай сотруднику показанные данные для входа.`);
    await Promise.all([loadUsers(), roleCanManage() ? loadOverview() : Promise.resolve()]);
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
$('runDiagnosticsBtn')?.addEventListener('click', async () => {
  $('diagnosticsOutput').textContent = 'Проверяю…';
  try {
    const data = await api('/api/workforce/admin/diagnostics');
    $('diagnosticsOutput').textContent = JSON.stringify(data, null, 2);
  } catch (error) { $('diagnosticsOutput').textContent = error.message; }
});
window.setInterval(() => {
  if (!currentUser || document.hidden) return;
  const refresh = [loadTasks()];
  if (roleCanAssignTasks()) refresh.push(loadOverview());
  if (roleCanReview()) refresh.push(loadReports(), loadDefectReports());
  Promise.all(refresh).catch(() => {});
}, 30000);
initialise();
