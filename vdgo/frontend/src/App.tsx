import { useCallback, useEffect, useRef, useState } from 'react';

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

const reportSections = [
  { id: 'main', number: '01', label: 'Основные данные', icon: '⌂' },
  { id: 'people', number: '02', label: 'Заказчик и специалисты', icon: '♙' },
  { id: 'calc', number: '03', label: 'УЗТ и ресурс', icon: '⌁' },
  { id: 'defects', number: '04', label: 'Дефекты', icon: '◇' },
  { id: 'valves', number: '05', label: 'Арматура', icon: '◈' },
  { id: 'photos', number: '06', label: 'Фотографии', icon: '▧' },
  { id: 'materials', number: '07', label: 'Схемы и акты', icon: '▤' },
  { id: 'test', number: '08', label: 'Герметичность', icon: '◉' },
  { id: 'finish', number: '09', label: 'Контроль перед выпуском', icon: '✓' },
];

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
  const [activeSection, setActiveSection] = useState('main');
  const reportFrame = useRef<HTMLIFrameElement | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch('/vdgo/api/health', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error(`API вернул HTTP ${response.status}`);
      const data = (await response.json()) as HealthResponse;
      setHealth(data);
      setHealthState(data.backend === 'ok' ? 'ok' : 'error');
      const db = data.database?.status;
      setDbState(db === 'ok' ? 'ok' : db === 'not-configured' ? 'not-configured' : 'error');
      setLastChecked(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      try {
        const recent = await fetch('/vdgo/api/reports', { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (recent.ok) {
          const result = (await recent.json()) as { items?: ReportRun[] };
          setReports(result.items ?? []);
        }
      } catch {
        // The report form remains available if the history endpoint is temporarily offline.
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

  const navigateToSection = (id: string) => {
    setActiveSection(id);
    try {
      const target = reportFrame.current?.contentWindow?.document.getElementById(id);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      // Navigation is only a visual convenience; the original form remains available in the frame.
    }
  };

  const formatDate = (value: string | null) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  };

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <a className="sidebar-brand" href="/vdgo/" aria-label="Профит — рабочий стол">
          <span className="sidebar-brand-mark" aria-hidden="true">П</span>
          <span className="sidebar-brand-name">PROFIT</span>
        </a>
        <div className="sidebar-caption">ТЕХНИЧЕСКОЕ ЗАКЛЮЧЕНИЕ</div>
        <nav className="sidebar-nav" aria-label="Разделы заключения">
          {reportSections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`sidebar-link${activeSection === section.id ? ' active' : ''}`}
              onClick={() => navigateToSection(section.id)}
              title={section.label}
            >
              <span className="sidebar-icon" aria-hidden="true">{section.icon}</span>
              <span className="sidebar-link-copy"><span>{section.label}</span><small>{section.number}</small></span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="sidebar-bottom-mark" aria-hidden="true">●</span>
          <span>Локальная система</span>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-path">
            <span className="home-glyph" aria-hidden="true">⌂</span>
            <span>Заключения</span>
            <span className="path-separator">›</span>
            <strong>Конструктор ВДГО</strong>
          </div>
          <div className="topbar-meta">
            <span className="version-tag">{health?.version ?? 'v5.3.7'}</span>
            <ServicePill label="Сервисы" state={healthState} />
            <ServicePill label="База данных" state={dbState} hint={health?.database?.message} />
            <button className="icon-button" type="button" onClick={() => void refreshStatus()} title="Обновить состояние сервисов" aria-label="Обновить состояние сервисов">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5.6 9A7 7 0 0 1 18 6.6L20 12M4 12l2 5.4A7 7 0 0 0 18.4 15" /></svg>
            </button>
          </div>
        </header>

        <main className="workspace">
          <section className="page-heading">
            <div className="page-heading-copy">
              <div className="breadcrumb"><span>Рабочий стол</span><span>›</span><strong>Техническое заключение ВДГО</strong></div>
              <div className="title-line">
                <h1>Техническое заключение ВДГО</h1>
                <span className="working-state"><i aria-hidden="true" />В работе</span>
              </div>
              <p>Заполнение фактических данных, проверка приложений и формирование итогового документа.</p>
            </div>
            <a className="outline-button" href="/vdgo/legacy" target="_blank" rel="noreferrer">
              Открыть отдельно <span aria-hidden="true">↗</span>
            </a>
          </section>

          <section className="form-panel" aria-label="Форма технического заключения">
            <div className="panel-heading">
              <div className="panel-title-line"><span className="panel-file-icon" aria-hidden="true">▤</span><div><h2>Данные заключения</h2><p>Все поля, проверки, вложения и экспорт сохранены без изменений.</p></div></div>
              <span className="form-version">PDF · DOCX</span>
            </div>
            <div className="frame-wrap">
              <iframe
                ref={reportFrame}
                className="legacy-frame"
                src="/vdgo/legacy"
                name="reportFrame"
                title="Форма заполнения технического заключения ВДГО"
                loading="eager"
                onLoad={() => {
                  try {
                    const hash = reportFrame.current?.contentWindow?.location.hash.replace('#', '');
                    if (hash && reportSections.some((section) => section.id === hash)) setActiveSection(hash);
                  } catch {
                    // Keep the selected section when frame access is unavailable.
                  }
                }}
              />
            </div>
          </section>

          <section className="bottom-grid">
            <article className="info-card">
              <span className="info-icon blue" aria-hidden="true">✓</span>
              <div><h3>Контроль перед выпуском</h3><p>Проверьте измерения, остаточный ресурс, фотографии и актуальность приложений перед формированием документа.</p></div>
            </article>
            <article className="info-card">
              <span className="info-icon slate" aria-hidden="true">◷</span>
              <div><h3>Состояние сервисов</h3><p>{lastChecked ? `Последняя проверка: ${lastChecked}.` : 'Проверяем доступность сервера и базы данных.'} {health?.database?.message ?? ''}</p></div>
            </article>
          </section>

          <section className="history-panel" aria-label="История формирования документов">
            <div className="history-heading"><div><div className="history-title-row"><span className="history-icon" aria-hidden="true">◷</span><h2>Журнал действий</h2></div><p>Последние сформированные документы. Содержимое отчётов в PostgreSQL не сохраняется.</p></div><span className="history-count">{reports.length} записей</span></div>
            {reports.length > 0 ? (
              <div className="history-table-wrap"><table className="history-table"><thead><tr><th>Время</th><th>Номер</th><th>Дата</th><th>Формат</th><th>Страницы</th></tr></thead><tbody>
                {reports.slice(0, 6).map((report) => <tr key={report.id}><td>{formatDate(report.created_at)}</td><td>{report.report_number || '—'}</td><td>{report.report_date || '—'}</td><td><span className="format-tag">{report.output_format.toUpperCase()}</span></td><td>{report.page_count}</td></tr>)}
              </tbody></table></div>
            ) : <div className="empty-history"><span className="empty-icon" aria-hidden="true">↗</span><strong>Документы пока не формировались</strong><span>После первого успешного экспорта журнал появится здесь, если PostgreSQL подключён.</span></div>}
          </section>

          <footer className="footer"><span>Профит · ВДГО</span><span>PDF / DOCX · локальная обработка</span></footer>
        </main>
      </div>
    </div>
  );
}

export default App;
