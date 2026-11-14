import { useCallback, useEffect, useState } from 'react';

type ServiceState = 'checking' | 'ok' | 'error' | 'not-configured' | 'unknown';

type HealthResponse = {
  status?: string;
  backend?: string;
  database?: { status?: string; configured?: boolean; message?: string };
  version?: string;
};

type ReportRun = {
  id: number;
  created_at: string | null;
  report_number: string;
  report_date: string;
  output_format: string;
  page_count: number;
  output_filename: string;
};

function ServicePill({ label, state, hint }: { label: string; state: ServiceState; hint?: string }) {
  const text: Record<ServiceState, string> = {
    checking: 'Проверка…', ok: 'Работает', error: 'Ошибка', 'not-configured': 'Локальный режим', unknown: 'Нет данных',
  };
  return (
    <div className={`service-pill service-${state}`} title={hint || text[state]}>
      <span className="service-dot" aria-hidden="true" />
      <span className="service-label">{label}</span>
      <strong>{text[state]}</strong>
    </div>
  );
}

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthState, setHealthState] = useState<ServiceState>('checking');
  const [dbState, setDbState] = useState<ServiceState>('checking');
  const [reports, setReports] = useState<ReportRun[]>([]);
  const [lastChecked, setLastChecked] = useState<string>('');

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/health', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error(`API вернул HTTP ${response.status}`);
      const data = (await response.json()) as HealthResponse;
      setHealth(data);
      setHealthState(data.backend === 'ok' ? 'ok' : 'error');
      const db = data.database?.status;
      setDbState(db === 'ok' ? 'ok' : db === 'not-configured' ? 'not-configured' : 'error');
      setLastChecked(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      try {
        const recent = await fetch('/api/reports', { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (recent.ok) {
          const result = (await recent.json()) as { items?: ReportRun[] };
          setReports(result.items ?? []);
        }
      } catch {
        // The form and exports remain available even if the history endpoint is temporarily offline.
      }
    } catch {
      setHealthState('error');
      setDbState('unknown');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const id = window.setInterval(() => void refreshStatus(), 15000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  const formatDate = (value: string | null) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="На главную">
          <span className="brand-mark" aria-hidden="true">П</span>
          <span className="brand-copy"><strong>Профит</strong><small>Система подготовки заключений</small></span>
        </a>
        <div className="topbar-meta">
          <span className="version-tag">MVP · {health?.version ?? 'v5.3.7'}</span>
          <ServicePill label="Backend API" state={healthState} />
          <ServicePill label="PostgreSQL" state={dbState} hint={health?.database?.message} />
          <button className="icon-button" type="button" onClick={() => void refreshStatus()} title="Обновить состояние сервисов" aria-label="Обновить состояние сервисов">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5.6 9A7 7 0 0 1 18 6.6L20 12M4 12l2 5.4A7 7 0 0 0 18.4 15" /></svg>
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="intro-card">
          <div className="intro-copy">
            <span className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span>
            <h1>Конструктор технического заключения ВДГО</h1>
            <p>Заполните фактические данные, проверьте вложения и сформируйте PDF или Word. Схемы Приложения 2 попадают в отчёт только из выбранных файлов; пустые фотолисты удаляются, а примеры из шаблона не подставляются автоматически.</p>
            <div className="intro-chips"><span>49 основных страниц + фотолисты</span><span>PDF + редактируемый DOCX</span><span>Локальная обработка</span></div>
          </div>
          <div className="intro-icon" aria-hidden="true">
            <svg viewBox="0 0 96 96"><rect x="20" y="12" width="55" height="70" rx="9"/><path d="M32 31h31M32 42h31M32 53h21M32 65h27"/><path d="M65 12v16h10"/></svg>
          </div>
        </section>

        <section className="form-panel">
          <div className="panel-heading">
            <div>
              <div className="panel-title-line"><span className="step-number">01</span><h2>Заполнение отчёта</h2></div>
              <p>Форма открыта в рабочем окне ниже. Навигация слева позволяет перейти к нужному разделу, кнопки экспорта расположены внизу формы.</p>
            </div>
            <a className="outline-button" href="/legacy" target="_blank" rel="noreferrer">
              Открыть отдельно <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div className="frame-wrap">
            <iframe className="legacy-frame" src="/legacy" title="Форма заполнения технического заключения ВДГО" loading="eager" />
          </div>
        </section>

        <section className="bottom-grid">
          <article className="info-card">
            <span className="info-icon blue" aria-hidden="true">✓</span>
            <div><h3>Контроль перед выпуском</h3><p>Проверяйте фактические измерения, расчёт остаточного ресурса, фотографии и актуальность приложений перед отправкой заказчику.</p></div>
          </article>
          <article className="info-card">
            <span className="info-icon slate" aria-hidden="true">↻</span>
            <div><h3>Состояние сервисов</h3><p>{lastChecked ? `Последняя проверка: ${lastChecked}.` : 'Проверяем доступность сервера и базы данных.'} {health?.database?.message ?? ''}</p></div>
          </article>
        </section>

        <section className="history-panel" aria-label="История формирования документов">
          <div className="history-heading"><div><h2>Последние формирования</h2><p>Технический журнал хранит номер, дату, формат и число страниц — содержимое отчётов в PostgreSQL не сохраняется.</p></div><span className="history-count">{reports.length} записей</span></div>
          {reports.length > 0 ? (
            <div className="history-table-wrap"><table className="history-table"><thead><tr><th>Время</th><th>Номер</th><th>Дата</th><th>Формат</th><th>Страницы</th></tr></thead><tbody>
              {reports.slice(0, 6).map((report) => <tr key={report.id}><td>{formatDate(report.created_at)}</td><td>{report.report_number || '—'}</td><td>{report.report_date || '—'}</td><td><span className="format-tag">{report.output_format.toUpperCase()}</span></td><td>{report.page_count}</td></tr>)}
            </tbody></table></div>
          ) : <div className="empty-history"><span className="empty-icon" aria-hidden="true">↗</span><strong>Документы пока не формировались</strong><span>После первого успешного экспорта журнал появится здесь, если PostgreSQL подключён.</span></div>}
        </section>

        <footer className="footer"><span>Профит · ВДГО</span><span>PDF / DOCX · React + TypeScript · Python</span></footer>
      </main>
    </div>
  );
}

export default App;
