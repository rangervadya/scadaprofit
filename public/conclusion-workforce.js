'use strict';
const root = document.getElementById('workforceConclusionSection');
const list = document.getElementById('workforceConclusionList');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dt = value => value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
async function loadWorkforceConclusion() {
  if (!root || !list) return;
  try {
    const response = await fetch('/api/workforce/conclusion', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { window.location.replace('/login.html'); return; }
    if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    const reports = data.reports || [];
    if (!reports.length) return;
    root.hidden = false;
    const focusId = new URLSearchParams(window.location.search).get('report');
    list.innerHTML = reports.map(report => `
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
  } catch (error) {
    root.hidden = false;
    list.innerHTML = `<p class="conclusion-empty">Не удалось загрузить схемы из выездов: ${esc(error.message)}</p>`;
  }
}
loadWorkforceConclusion();
