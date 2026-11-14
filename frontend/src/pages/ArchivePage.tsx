import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import { Badge, Button, Card, Empty, Loading } from '../components/ui';
import { cadApi, healthApi } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ManualCadProjectSummary, ReportRun } from '../lib/types';

type Tab = 'reports' | 'cad' | 'schemes';

export function ArchivePage() {
  const [tab, setTab] = useState<Tab>('reports');
  const [reports, setReports] = useState<ReportRun[]>([]);
  const [projects, setProjects] = useState<ManualCadProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reportData, projectData] = await Promise.all([
        healthApi.archiveReports(),
        cadApi.list(),
      ]);
      setReports(Array.isArray(reportData.items) ? reportData.items : []);
      setProjects(Array.isArray(projectData.projects) ? projectData.projects : []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить архив');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const formats = useMemo(() => Array.from(new Set(reports.map(report => report.output_format).filter(Boolean))), [reports]);

  const filteredReports = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru');
    return reports.filter(report => {
      if (format !== 'all' && report.output_format !== format) return false;
      if (!needle) return true;
      return `${report.report_number} ${report.report_date} ${report.output_filename}`.toLocaleLowerCase('ru').includes(needle);
    });
  }, [reports, query, format]);

  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru');
    if (!needle) return projects;
    return projects.filter(project => `${project.title} ${project.siteAddress}`.toLocaleLowerCase('ru').includes(needle));
  }, [projects, query]);

  const downloadReport = (report: ReportRun) => {
    if (!report.archived) return;
    window.location.assign(`/vdgo/api/reports/${report.id}/download`);
  };

  return (
    <>
      <header className="page__header">
        <div>
          <p className="page__eyebrow">История</p>
          <h1>Архив</h1>
          <p className="page__subtitle">Сформированные заключения, ручные схемы и CAD-проекты.</p>
        </div>
        <div className="page__actions">
          <Button icon="refresh" onClick={() => void load()} disabled={loading}>Обновить</Button>
          <Link className="btn btn--primary" to="/conclusion"><Icon name="doc" /> Новое заключение</Link>
        </div>
      </header>

      <div className="row row--wrap">
        <div className="tabs" role="tablist">
          {([
            ['reports', `Заключения · ${reports.length}`],
            ['cad', `CAD-проекты · ${projects.length}`],
            ['schemes', 'Схемы домов'],
          ] as Array<[Tab, string]>).map(([key, label]) => (
            <button key={key} type="button" role="tab" className="tabs__tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
        <span className="grow" />
        <div className="searchbox" style={{ width: 'min(340px, 100%)' }}>
          <Icon name="search" />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск по архиву…" aria-label="Поиск по архиву" />
        </div>
        {tab === 'reports' && formats.length ? (
          <select className="select" style={{ width: 170 }} value={format} onChange={event => setFormat(event.target.value)} aria-label="Формат">
            <option value="all">Все форматы</option>
            {formats.map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}
          </select>
        ) : null}
      </div>

      {loading ? <Card><Loading>Загружаем архив…</Loading></Card> : null}

      {error ? (
        <div className="alert alert--danger"><Icon name="alert" /><div><div style={{ fontWeight: 650 }}>{error}</div><div className="row" style={{ marginTop: 8 }}><Button size="sm" onClick={() => void load()}>Повторить</Button></div></div></div>
      ) : null}

      {!loading && !error && tab === 'reports' ? (
        <Card title="Сформированные заключения" flush>
          {filteredReports.length === 0 ? (
            <Empty icon="archive" title="Записей нет">История появится после формирования первого заключения.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Номер</th><th>Дата заключения</th><th>Формат</th><th>Страниц</th><th>Создано</th><th>Файл</th><th /></tr></thead>
                <tbody>
                  {filteredReports.map(report => (
                    <tr key={report.id}>
                      <td className="mono">{report.report_number || '—'}</td>
                      <td className="nowrap">{report.report_date || '—'}</td>
                      <td><Badge tone="brand" plain>{report.output_format?.toUpperCase() || '—'}</Badge></td>
                      <td className="num">{report.page_count || '—'}</td>
                      <td className="nowrap muted">{formatDateTime(report.created_at)}</td>
                      <td className="text-truncate" style={{ maxWidth: 260 }} title={report.original_filename || report.output_filename}>
                        {report.original_filename || report.output_filename}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {report.archived ? (
                          <Button size="sm" icon="download" onClick={() => downloadReport(report)}>Скачать</Button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {!loading && !error && tab === 'cad' ? (
        <Card title="Ручные CAD-проекты" flush>
          {filteredProjects.length === 0 ? (
            <Empty icon="cad" title="Проектов нет" action={<Link className="btn btn--primary btn--sm" to="/cad"><Icon name="plus" /> Создать чертёж</Link>} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Название</th><th>Адрес</th><th>Труб</th><th>Обновлён</th><th /></tr></thead>
                <tbody>
                  {filteredProjects.map(project => (
                    <tr key={project.id}>
                      <td>{project.title}</td>
                      <td className="muted">{project.siteAddress || '—'}</td>
                      <td className="num">{project.pipeCount}</td>
                      <td className="nowrap muted">{formatDateTime(project.updatedAt)}</td>
                      <td style={{ textAlign: 'right' }}><Link className="btn btn--sm" to={`/cad/${project.id}`}>Открыть</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {!loading && !error && tab === 'schemes' ? (
        <Card title="Схемы домов">
          <Empty icon="scheme" title="Перейдите к схемам" action={<Link className="btn btn--primary btn--sm" to="/schemes"><Icon name="scheme" /> Открыть схемы домов</Link>}>
            Архив схем доступен в разделе «Схемы домов»: папки улиц, дома и статусы распознавания.
          </Empty>
        </Card>
      ) : null}
    </>
  );
}