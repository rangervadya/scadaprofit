import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

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
  ['main', 'Основные данные'],
  ['people', 'Заказчик и специалисты'],
  ['calc', 'УЗТ и ресурс'],
  ['defects', 'Дефекты'],
  ['valves', 'Арматура и проверки'],
  ['photos', 'Фото и приложения'],
  ['test', 'Герметичность'],
  ['finish', 'Контроль перед выпуском'],
  ['materials', 'Схемы и акты'],
];

function Drawing({ sketch = false }: { sketch?: boolean }) {
  return (
    <svg className={sketch ? 'drawing sketch' : 'drawing'} viewBox="0 0 320 285" role="img" aria-label={sketch ? 'Пример исходного эскиза' : 'Пример реконструкции'}>
      <g fill="none" stroke="currentColor">
        <path strokeWidth=".6" d="M39 32H95M39 81H74M30 182H100M55 235H112M46 32V235m-4-199 8-8m-8 57 8-8m-8 109 8-8m-8 61 8-8M100 224V262m75-47v47m110-52v52M100 254h185m-189 4 8-8m67 8 8-8m102 8 8-8M276 55h27m-25 92h25m-25 69h25M298 55v161m-4-157 8-8m-8 100 8-8m-8 77 8-8"/>
        <path strokeWidth={sketch ? 1 : 4} d="M73 33h106v22h105v161H175v25h-71v-59H73V33m0 87h102V55m0 65v96m0-68h109m-180 34h71"/>
        <path stroke={sketch ? 'currentColor' : '#8ab8de'} strokeWidth="1.1" d="M73 33h106v22h105v161H175v25h-71v-59H73V33m0 87h102V55m0 65v96m0-68h109m-180 34h71"/>
        <path strokeWidth=".8" d="m109 120 14-15h18m79 43 14-14h18m-70-88 17-19"/>
        <circle cx="204" cy="21" r="10" strokeWidth=".8"/>
        <g fill="#f7f9fc" strokeWidth="1">
          <path d="M65 77h16v6H65zm57 39h18v8h-18zm48 46h10v18h-10zm53-111h18v8h-18zm-2 93h18v8h-18zm0 68h18v8h-18zm-126-13h17v7H95zm183-20h12v7h-12z"/>
        </g>
      </g>
      <g fill="currentColor" fontSize="8" fontStyle={sketch ? 'italic' : undefined}>
        <text x="202" y="24">1</text><text x="122" y="102">⌀32</text><text x="231" y="131">⌀25</text>
        <text x="22" y="79">630</text><text x="19" y="180">⌀29</text><text x="266" y="141">⌀35</text>
        <text x="123" y="249">315</text><text x="219" y="249">590</text>
        {sketch && <text x="139" y="16" fontSize="12">Эскиз газопровода</text>}
      </g>
    </svg>
  );
}

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthState, setHealthState] = useState<ServiceState>('checking');
  const [dbState, setDbState] = useState<ServiceState>('checking');
  const [reports, setReports] = useState<ReportRun[]>([]);
  const [activeSection, setActiveSection] = useState('main');
  const [searchMessage, setSearchMessage] = useState('');
  const initialHistoryQuery = new URLSearchParams(window.location.search).get('q') || '';
  const [historyQuery, setHistoryQuery] = useState(initialHistoryQuery.toLocaleLowerCase('ru'));
  const historyActive = window.location.pathname.replace(/\/$/, '') === '/vdgo/?view=history';
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [details, setDetails] = useState(false);
  const [report, setReport] = useState({ number: '', address: '', date: '' });
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState('');
  const [preview, setPreview] = useState<'both' | 'source' | 'result'>('both');
  const [zoom, setZoom] = useState(100);
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
      try {
        const recent = await fetch('/vdgo/api/reports', { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!recent.ok) throw new Error('Не удалось загрузить историю');
        const result = (await recent.json()) as { items?: ReportRun[] };
        setReports(result.items ?? []);
        setHistoryState('ready');
      } catch {
        setHistoryState('error');
      }
    } catch {
      setHealthState('error');
      setDbState('unknown');
      setHistoryState('error');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const id = window.setInterval(() => void refreshStatus(), 15000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => {
    document.title = historyActive ? 'История · ПРОФИТ' : 'Техническое заключение ВДГО · ПРОФИТ';
  }, [historyActive]);

  const matchesHistory = (item: ReportRun, query: string) =>
    [item.report_number, item.report_date, item.output_filename].some(value => value?.toLocaleLowerCase('ru').includes(query));

  const shownReports = (historyQuery ? reports.filter(item => matchesHistory(item, historyQuery)) : reports);

  const navigateToSection = (id: string) => {
    setActiveSection(id);
    setDetails(id !== 'main');
    requestAnimationFrame(() => reportFrame.current?.contentDocument?.getElementById(id)?.scrollIntoView({ block: 'start' }));
  };

  const formatDate = (value: string | null) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  };

  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) {
      setFileUrl('');
      return;
    }
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useLayoutEffect(() => {
    reportFrame.current?.contentDocument?.documentElement.classList.toggle('workspace-summary', !details);
  }, [details]);

  function connectForm() {
    const doc = reportFrame.current?.contentDocument;
    if (!doc) return;
    doc.documentElement.classList.toggle('workspace-summary', !details);
    const form = doc.querySelector<HTMLFormElement>('#form');
    if (!form) return;
    const syncHeader = () => {
      const data = new FormData(form);
      setReport({
        number: String(data.get('report_number') || ''),
        address: String(data.get('address') || ''),
        date: String(data.get('report_date') || ''),
      });
    };
    form.addEventListener('input', syncHeader);
    form.addEventListener('change', syncHeader);
    form.addEventListener('reset', () => requestAnimationFrame(syncHeader));
    syncHeader();
  }

  function runFormAction(action: string) {
    if (action !== 'save') {
      flushSync(() => {
        setDetails(true);
        setActiveSection('finish');
      });
    }
    reportFrame.current?.contentDocument?.querySelector<HTMLButtonElement>(`[data-workspace-action="${action}"]`)?.click();
  }

  function selectFile(image: File) {
    setFile(image);
    setPreview('both');
    navigateToSection('main');
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <a className="sidebar-brand" href="/dashboard.html" aria-label="Профит — рабочий стол">
          <svg viewBox="0 0 32 36" width="29" height="33" aria-hidden="true"><path fill="#63b9ff" d="M19 1c1 8-7 10-7 17 0 2 1 3 2 4-5-1-8-4-7-8C9 9 15 6 19 1Z"/><path fill="#3189e4" d="M21 12c7 5 9 10 6 16-2 4-6 6-11 7 4-3 5-6 3-9-1-2-4-3-4-6 0-3 3-6 6-8Z"/><path fill="#a2d6ff" d="M6 19c0 5 6 7 7 11l-2 4C5 31 2 26 6 19Z"/></svg>
          <span className="sidebar-brand-name">PROFIT</span>
        </a>
        <nav className="sidebar-nav" aria-label="Модули ПРОФИТ">
          <a className="sidebar-link" href="/dashboard.html"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10h-6v-6H9v6H3z"/></svg>Рабочий стол</a>
          <a className={historyActive ? "sidebar-link" : "sidebar-link active"} href="/vdgo/" aria-current={historyActive ? undefined : "page"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/></svg>Заключение</a>
          <a className="sidebar-link" href="/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l5-4 4 4 5-7 4 4M4 12v8h16V9M9 20v-5h5v5"/></svg>Схемы домов</a>
          <a className="sidebar-link" href="/archive"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18v5H3zm2 5v11h14V9M10 13h4"/></svg>Архив</a>
          <a className="sidebar-link" href="/settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-5 2v4"/></svg>Настройки</a>
        </nav>
        <a className="sidebar-bottom" href="/vdgo/legacy" target="_blank" rel="noreferrer">ⓘ　Полная форма</a>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <form className="search" role="search" onSubmit={(event) => {
            event.preventDefault();
            const query = String(new FormData(event.currentTarget).get('query') || '').trim().toLocaleLowerCase('ru');
            if (!query) return;
            setSearchMessage('');
            if (historyActive) {
              setHistoryQuery(query);
              return;
            }
            const section = reportSections.find(([, label]) => label.toLocaleLowerCase('ru').includes(query));
            if (section) navigateToSection(section[0]);
            else if ([report.number, report.address, report.date].some(value => value.toLocaleLowerCase('ru').includes(query))) navigateToSection('main');
            else if (reports.some(item => matchesHistory(item, query))) window.location.assign(`/vdgo/?view=history?q=${encodeURIComponent(query)}`);
            else setSearchMessage('Ничего не найдено');
          }}>
            <span aria-hidden="true">⌕</span>
            <input name="query" type="search" placeholder={historyActive ? 'Поиск по номеру, дате или имени файла…' : 'Поиск по адресу, номеру и разделам…'} aria-label={historyActive ? 'Поиск по истории документов' : 'Поиск по адресу, номеру и разделам'} defaultValue={historyActive ? initialHistoryQuery : undefined} onChange={(event) => {
              setSearchMessage('');
              if (historyActive) setHistoryQuery(event.currentTarget.value.trim().toLocaleLowerCase('ru'));
            }} />
            <button title="Найти" aria-label="Найти">↵</button>
            <output aria-live="polite">{searchMessage}</output>
          </form>
          <button className="service-status" onClick={() => void refreshStatus()} title={health?.database?.message || 'Обновить состояние сервисов'}>
            <i className={healthState} />{healthState === 'checking' ? 'Проверяем сервисы…' : healthState === 'ok' && dbState !== 'error' ? 'Сервисы работают' : 'Проверьте сервисы'}
          </button>
          <span className="avatar" aria-hidden="true">ВД</span><span>ВДГО</span>
        </header>

        {historyActive ? <>
          <div className="breadcrumb">⌂　Рабочий стол　›　История</div>
          <section className="page-heading">
            <div><h1>История</h1><p>Последние сформированные технические заключения.</p></div>
            <a href="/vdgo/" className="history-action">Подготовить заключение →</a>
          </section>
          <section className="card history-screen" aria-label="Журнал формирования документов">
            <header><h2>Журнал формирования документов</h2><button onClick={() => void refreshStatus()}>Обновить</button></header>
            {shownReports.length > 0 ? <div className="history-table-wrap">
              <table>
                <thead><tr><th>Сформирован</th><th>Номер</th><th>Дата заключения</th><th>Файл</th><th>Страниц</th></tr></thead>
                <tbody>{shownReports.map(item => <tr key={item.id}>
                  <td>{formatDate(item.created_at)}</td><td>{item.report_number || '—'}</td><td>{item.report_date || '—'}</td>
                  <td>{item.output_filename || item.output_format.toUpperCase()}</td><td>{item.page_count}</td>
                </tr>)}</tbody>
              </table>
            </div> : <p className="history-empty" role="status">{historyState === 'loading' ? 'Загружаем журнал…' : historyState === 'error' ? 'Журнал недоступен. Обновите данные, чтобы повторить попытку.' : dbState === 'not-configured' ? 'В локальном режиме журнал документов отключён.' : historyQuery ? 'Документы по этому запросу не найдены.' : 'Документы пока не формировались.'}</p>}
          </section>
        </> : <>
        <div className="breadcrumb">⌂　　Заключения　›　 Техническое заключение ВДГО</div>
        <section className="page-heading">
          <div>
            <div className="title-line"><h1>Техническое заключение {report.number ? `№ ${report.number}` : 'ВДГО'}</h1><span className="working-state">В работе</span></div>
            <p>♧　{report.address || 'Адрес объекта'}　　▦　{report.date || 'Дата заключения'}</p>
          </div>
          <div className="heading-actions">
            <button onClick={() => runFormAction('save')}>▣　Сохранить</button>
            <button onClick={() => runFormAction('preview')}>✓　Проверить</button>
            <button className="primary" onClick={() => runFormAction('generate')}>Сформировать документ　 →</button>
          </div>
        </section>

        <nav className="report-tabs" aria-label="Разделы заключения">
          {reportSections.map(([id, label], index) => (
            <button key={id} aria-current={activeSection === id ? 'location' : undefined} onClick={() => navigateToSection(id)}>
              <span>{index + 1}</span>{label}
            </button>
          ))}
        </nav>

        <div className={details ? 'workbench details' : 'workbench'}>
          <section className="card form-panel" aria-label="Данные заключения">
            <header><h2>▤　{details ? 'Данные заключения' : 'Основные данные'}</h2>
              <button onClick={() => details ? navigateToSection('main') : setDetails(true)}>{details ? 'К чертежу' : 'Все поля ↗'}</button>
            </header>
            <iframe ref={reportFrame} src="/vdgo/legacy" title="Форма технического заключения" onLoad={connectForm} />
          </section>

          <section className="card drawing-panel" aria-label="Сравнение чертежей" hidden={details}>
            <header className="drawing-tabs">
              <button aria-pressed={preview !== 'result'} onClick={() => setPreview(preview === 'source' ? 'both' : 'source')}>▧　Исходный чертёж</button>
              <button aria-pressed={preview === 'result'} onClick={() => setPreview(preview === 'result' ? 'both' : 'result')}>◇　Результат реконструкции</button>
            </header>
            <div className="drawing-grid" data-preview={preview}>
              {preview !== 'result' && <div className="drawing-pane">
                <div className="drawing-bar"><button title="Загрузить чертёж" onClick={() => upload.current?.click()}>↑</button><a title="Открыть распознавание эскизов" href="/">⌕</a></div>
                <div className="drawing-surface source-surface">{fileUrl ? <img src={fileUrl} alt="Загруженный эскиз" /> : <Drawing sketch />}</div>
              </div>}
              {preview !== 'source' && <div className="drawing-pane">
                <div className="drawing-bar">
                  <a href="/manual-cad.html" title="Открыть CAD-редактор">↗</a>
                  <label className="zoom"><select value={zoom} aria-label="Масштаб чертежа" onChange={(event) => setZoom(Number(event.target.value))}>{[75, 100, 125, 150].map((value) => <option key={value} value={value}>{value}%</option>)}</select></label>
                  <button title={preview === 'result' ? 'Показать оба чертежа' : 'Развернуть результат'} onClick={() => setPreview(preview === 'result' ? 'both' : 'result')}>⤢</button>
                </div>
                <div className="drawing-surface">
                  {file ? <a className="recognize-link" href="/">Перейти к распознаванию эскиза →</a> : <div className="drawing-zoom" style={{ width: `${zoom}%` }}><Drawing /></div>}
                </div>
              </div>}
              {preview === 'both' && <button className="compare-toggle" aria-label="Развернуть результат" onClick={() => setPreview('result')}>↔</button>}
            </div>
            {!file && <small className="sample-label">Демонстрационный чертёж</small>}
          </section>

          <aside className="card tool-panel" hidden={details}>
            <header><h2>Инструменты</h2></header>
            <a href="/manual-cad.html">↗　CAD-редактор</a>
            <a href="/">⌕　Распознавание</a>
            <button onClick={() => setPreview('both')}>↔　Сравнение</button>
            <button onClick={() => upload.current?.click()}>↑　Загрузить эскиз</button>
            <div className="tool-properties">
              <h3>Чертёж</h3>
              <p><i />{file ? 'Загруженный эскиз' : 'Демонстрационный'}</p>
              <p>Масштаб　{zoom}%</p>
            </div>
          </aside>
        </div>

        <section className="bottom-grid">
          <article id="history" className="card bottom-card">
            <h2>◷　Журнал действий</h2>
            {reports.length ? <ul>{reports.slice(0, 3).map((item) => <li key={item.id}>{formatDate(item.created_at)}　 ·　{item.report_number || item.output_filename}　{item.output_format.toUpperCase()}</li>)}</ul> : <p>Документы пока не формировались</p>}
            <a className="history-link" href="/vdgo/?view=history">Вся история →</a>
          </article>
          <article id="attachments" className="card bottom-card">
            <h2>♧　Файлы и вложения</h2>
            {file && fileUrl ? <div className="file-row"><img src={fileUrl} alt="" /><a href={fileUrl} download={file.name}>{file.name}　↓</a><button onClick={() => setFile(null)} aria-label="Удалить эскиз">×</button></div> : <button onClick={() => navigateToSection('materials')}>Открыть вложения заключения　→</button>}
          </article>
          <div className="card upload-card" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
            event.preventDefault();
            const image = event.dataTransfer.files[0];
            if (image && /^image\/(jpeg|png|webp)$/.test(image.type)) selectFile(image);
          }}>
            <input ref={upload} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => {
              const image = event.currentTarget.files?.[0];
              if (image) selectFile(image);
              event.currentTarget.value = '';
            }} />
            <button onClick={() => upload.current?.click()}><span aria-hidden="true">⇧</span>Загрузить эскиз<small>или перетащите сюда</small></button>
          </div>
        </section>
        </>}
      </main>
    </div>
  );
}

export default App;
