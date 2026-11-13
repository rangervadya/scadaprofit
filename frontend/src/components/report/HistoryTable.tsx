import type { ReportRun } from '../../types';
import { formatDate } from '../../utils';

interface HistoryTableProps {
  reports: ReportRun[];
}

export function HistoryTable({ reports }: HistoryTableProps) {
  const shownReports = reports.slice(0, 3);

  return (
    <article id="history" className="card bottom-card">
      <h2>◷　Журнал действий</h2>
      {shownReports.length ? (
        <ul>
          {shownReports.map((item) => (
            <li key={item.id}>
              {formatDate(item.created_at)}　 ·　{item.report_number || item.output_filename}　{item.output_format.toUpperCase()}
            </li>
          ))}
        </ul>
      ) : (
        <p>Документы пока не формировались</p>
      )}
      <a className="history-link" href="/vdgo/?view=history">
        Вся история →
      </a>
    </article>
  );
}
