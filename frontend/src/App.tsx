import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useHealthStatus } from './hooks/useHealthStatus';
import { formatDate } from './utils';
import { Sidebar } from './components/shell/Sidebar';
import { Topbar } from './components/shell/Topbar';
import { DrawingCanvas } from './components/report/DrawingCanvas';
import { ReportTabs } from './components/report/ReportTabs';
import { ToolPanel } from './components/report/ToolPanel';
import { HistoryTable } from './components/report/HistoryTable';
import { FileUpload } from './components/form/FileUpload';
import { ErrorBoundary } from './components/ErrorBoundary';
import { reportSections } from './types';

function App() {
  const [activeSection, setActiveSection] = useState('main');
  const [details, setDetails] = useState(false);
  const [report, setReport] = useState({ number: '', address: '', date: '' });
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState('');
  const [preview, setPreview] = useState<'both' | 'source' | 'result'>('both');
  const [zoom, setZoom] = useState(100);
  const [progress, setProgress] = useState<Record<string, { filled: number; total: number }>>({});
  const [fullScreenMessage, setFullScreenMessage] = useState('');
  const reportFrame = useRef<HTMLIFrameElement | null>(null);

  const {
    health,
    healthState,
    dbState,
    reports,
    historyState,
    refreshStatus,
  } = useHealthStatus();

  const [searchMessage, setSearchMessage] = useState('');
  const initialHistoryQuery = new URLSearchParams(window.location.search).get('q') || '';
  const [historyQuery] = useState(initialHistoryQuery.toLocaleLowerCase('ru'));
  const historyActive = window.location.pathname.replace(/\/$/, '') === '/vdgo/?view=history';

  useEffect(() => {
    document.title = historyActive ? 'История · ПРОФИТ' : 'Техническое заключение ВДГО · ПРОФИТ';
  }, [historyActive]);

  const shownReports = historyQuery ? reports.filter((item) => item.report_number?.toLocaleLowerCase('ru').includes(historyQuery) || item.report_date?.toLocaleLowerCase('ru').includes(historyQuery) || item.output_filename?.toLocaleLowerCase('ru').includes(historyQuery)) : reports;

  const navigateToSection = (id: string) => {
    setActiveSection(id);
    setDetails(id !== 'main');
    requestAnimationFrame(() => reportFrame.current?.contentDocument?.getElementById(id)?.scrollIntoView({ block: 'start' }));
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
    try {
      const doc = reportFrame.current?.contentDocument;
      if (doc?.documentElement) {
        doc.documentElement.classList.toggle('workspace-summary', !details);
      }
    } catch {
      // iframe may not be loaded (backend unavailable)
    }
  }, [details]);

  function connectForm() {
    try {
      const doc = reportFrame.current?.contentDocument;
      if (!doc) return;
      doc.documentElement.classList.toggle('workspace-summary', !details);
      const form = doc.querySelector<HTMLFormElement>('#form');
      if (!form) return;
      const syncHeader = () => {
        const data = new FormData(form);
        setProgress(Object.fromEntries(reportSections.map(([id]) => {
          const fields = [...(doc.getElementById(id)?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[required]') ?? [])]
            .filter(field => field.willValidate);
          return [id, { filled: fields.filter(field => field.validity.valid && field.value.trim()).length, total: fields.length }];
        })));
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
    } catch {
      // iframe may not be loaded (backend unavailable)
    }
  }

  function runFormAction(action: string) {
    if (action !== 'save') {
      flushSync(() => {
        setDetails(true);
        setActiveSection('finish');
      });
    }
    try {
      reportFrame.current?.contentDocument?.querySelector<HTMLButtonElement>(`[data-workspace-action="${action}"]`)?.click();
    } catch {
      // iframe may not be loaded (backend unavailable)
    }
  }

  function selectFile(image: File) {
    setFile(image);
    setPreview('both');
    navigateToSection('main');
  }

  return (
    <div className="app-shell">
      <Sidebar historyActive={historyActive} />

      <main className="workspace">
        <Topbar
          health={health}
          healthState={healthState}
          dbState={dbState}
          refreshStatus={refreshStatus}
          historyActive={historyActive}
          initialHistoryQuery={initialHistoryQuery}
          reports={reports}
          searchMessage={searchMessage}
          setSearchMessage={setSearchMessage}
          report={report}
          navigateToSection={navigateToSection}
        />

        {historyActive ? (
          <>
            <div className="breadcrumb">⌂　Рабочий стол　›　История</div>
            <section className="page-heading">
              <div>
                <h1>История</h1>
                <p>Последние сформированные технические заключения.</p>
              </div>
              <a href="/conclusion.html" className="history-action">Подготовить заключение →</a>
            </section>
            <section className="card history-screen" aria-label="Журнал формирования документов">
              <header>
                <h2>Журнал формирования документов</h2>
                <button onClick={() => void refreshStatus()}>Обновить</button>
              </header>
              {shownReports.length > 0 ? (
                <div className="history-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Сформирован</th>
                        <th>Номер</th>
                        <th>Дата заключения</th>
                        <th>Файл</th>
                        <th>Страниц</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownReports.map((item) => (
                        <tr key={item.id}>
                          <td>{formatDate(item.created_at)}</td>
                          <td>{item.report_number || '—'}</td>
                          <td>{item.report_date || '—'}</td>
                          <td>{item.output_filename || item.output_format.toUpperCase()}</td>
                          <td>{item.page_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="history-empty" role="status">
                  {historyState === 'loading'
                    ? 'Загружаем журнал…'
                    : historyState === 'error'
                      ? 'Журнал недоступен. Обновите данные, чтобы повторить попытку.'
                      : dbState === 'not-configured'
                        ? 'В локальном режиме журнал документов отключён.'
                        : historyQuery
                          ? 'Документы по этому запросу не найдены.'
                          : 'Документы пока не формировались.'}
                </p>
              )}
            </section>
          </>
        ) : (
          <>
            <div className="breadcrumb">⌂　　Заключения　›　 Техническое заключение ВДГО</div>
            <section className="page-heading">
              <div>
                <div className="title-line">
                  <h1>Техническое заключение {report.number ? `№ ${report.number}` : 'ВДГО'}</h1>
                  <span className="working-state">В работе</span>
                </div>
                <p>♧　{report.address || 'Адрес объекта'}　　▦　{report.date || 'Дата заключения'}</p>
              </div>
              <div className="heading-actions">
                <a className="history-action" href="/vdgo/legacy" target="_blank" rel="noreferrer">
                  Полная форма
                </a>
                <button onClick={() => runFormAction('save')}>▣　Сохранить</button>
                <button onClick={() => runFormAction('preview')}>✓　Проверить</button>
                <button className="primary" onClick={() => runFormAction('generate')}>
                  Сформировать документ　 →
                </button>
              </div>
            </section>

            <ReportTabs
              sections={reportSections}
              activeSection={activeSection}
              progress={progress}
              onSectionClick={navigateToSection}
            />

            <div className={details ? 'workbench details' : 'workbench'}>
              <section className="card form-panel" aria-label="Данные заключения">
                <header>
                  <h2>▤　{details ? 'Данные заключения' : 'Основные данные'}</h2>
                  <button onClick={() => (details ? navigateToSection('main') : setDetails(true))}>
                    {details ? 'К чертежу' : 'Все поля ↗'}
                  </button>
                </header>
                <ErrorBoundary fallback={<div className="card" style={{ padding: 16 }}>
                  <h3>Форма недоступна</h3>
                  <p>Бэкенд не отвечает. Запустите сервер на порту 8765 для работы с формой заключения.</p>
                </div>}>
                  <iframe ref={reportFrame} src="/vdgo/legacy" title="Форма технического заключения" onLoad={connectForm} />
                </ErrorBoundary>
              </section>

              <section className="card drawing-panel" aria-label="Сравнение чертежей" hidden={details}>
                <header className="drawing-tabs">
                  <button
                    aria-pressed={preview !== 'result'}
                    onClick={() => setPreview(preview === 'source' ? 'both' : 'source')}
                  >
                    ▧　Исходный чертёж
                  </button>
                  <button
                    aria-pressed={preview === 'result'}
                    onClick={() => setPreview(preview === 'result' ? 'both' : 'result')}
                  >
                    ◇　Результат реконструкции
                  </button>
                  <button
                    className="fullscreen-button"
                    onClick={async (event) => {
                      const panel = event.currentTarget.closest('.drawing-panel');
                      setFullScreenMessage('');
                      try {
                        if (document.fullscreenElement === panel) await document.exitFullscreen();
                        else if (panel) {
                          setPreview('both');
                          await panel.requestFullscreen();
                        }
                      } catch {
                        setFullScreenMessage('Полноэкранный режим недоступен в этом браузере.');
                      }
                    }}
                  >
                    <span className="enter-fullscreen">На весь экран</span>
                    <span className="exit-fullscreen">Свернуть</span>
                  </button>
                </header>
                {fullScreenMessage && <p role="status">{fullScreenMessage}</p>}
                <div className="drawing-grid" data-preview={preview}>
                  {preview !== 'result' && (
                    <div className="drawing-pane">
                      <div className="drawing-bar">
                        <button title="Загрузить чертёж" onClick={() => upload.current?.click()}>
                          ↑
                        </button>
                        <a title="Открыть распознавание эскизов" href="/">
                          ⌕
                        </a>
                      </div>
                      <div className="drawing-surface source-surface">
                        {fileUrl ? <img src={fileUrl} alt="Загруженный эскиз" /> : <DrawingCanvas sketch />}
                      </div>
                    </div>
                  )}
                  {preview !== 'source' && (
                    <div className="drawing-pane">
                      <div className="drawing-bar">
                        <a href="/manual-cad.html" title="Открыть CAD-редактор">
                          ↗
                        </a>
                        <label className="zoom">
                          <select
                            value={zoom}
                            aria-label="Масштаб чертежа"
                            onChange={(event) => setZoom(Number(event.target.value))}
                          >
                            {[75, 100, 125, 150].map((value) => (
                              <option key={value} value={value}>
                                {value}%
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          title={preview === 'result' ? 'Показать оба чертежа' : 'Развернуть результат'}
                          onClick={() => setPreview(preview === 'result' ? 'both' : 'result')}
                        >
                          ⤢
                        </button>
                      </div>
                      <div className="drawing-surface">
                        {file ? (
                          <a className="recognize-link" href="/">
                            Перейти к распознаванию эскиза →
                          </a>
                        ) : (
                          <div className="drawing-zoom" style={{ width: `${zoom}%` }}>
                            <DrawingCanvas />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {preview === 'both' && (
                    <button
                      className="compare-toggle"
                      aria-label="Развернуть результат"
                      onClick={() => setPreview('result')}
                    >
                      ↔
                    </button>
                  )}
                </div>
                {!file && <small className="sample-label">Демонстрационный чертёж</small>}
              </section>

              <ToolPanel
                file={file}
                zoom={zoom}
                onUploadClick={() => upload.current?.click()}
                onPreviewBoth={() => setPreview('both')}
              />
            </div>

            <section className="bottom-grid">
              <HistoryTable reports={reports} />
              <article id="attachments" className="card bottom-card">
                <h2>♧　Файлы и вложения</h2>
                {file && fileUrl ? (
                  <div className="file-row">
                    <img src={fileUrl} alt="" />
                    <a href={fileUrl} download={file.name}>
                      {file.name}　↓
                    </a>
                    <button onClick={() => setFile(null)} aria-label="Удалить эскиз">
                      ×
                    </button>
                  </div>
                ) : (
                  <button onClick={() => navigateToSection('materials')}>Открыть вложения заключения　→</button>
                )}
              </article>
              <FileUpload
                onSelectFile={selectFile}
                onDrop={selectFile}
                uploadRef={upload}
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
