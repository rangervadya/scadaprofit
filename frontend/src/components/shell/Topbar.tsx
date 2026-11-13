import { useState } from 'react';
import type { HealthResponse, ReportRun, ServiceState } from '../../types';
import { matchesHistory } from '../../utils';

interface TopbarProps {
  health: HealthResponse | null;
  healthState: ServiceState;
  dbState: ServiceState;
  refreshStatus: () => void;
  historyActive: boolean;
  initialHistoryQuery: string;
  reports: ReportRun[];
  searchMessage: string;
  setSearchMessage: (msg: string) => void;
  report: { number: string; address: string; date: string };
  navigateToSection: (id: string) => void;
}

export function Topbar({
  health,
  healthState,
  dbState,
  refreshStatus,
  historyActive,
  initialHistoryQuery,
  reports,
  searchMessage,
  setSearchMessage,
  report,
  navigateToSection,
}: TopbarProps) {
  const [queryInput, setQueryInput] = useState(historyActive ? initialHistoryQuery : '');

  const handleSearchSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = queryInput.trim().toLocaleLowerCase('ru');
    if (!query) return;
    setSearchMessage('');
    if (historyActive) {
      window.location.assign(`/vdgo/?view=history&q=${encodeURIComponent(query)}`);
      return;
    }
    const section = ['main', 'people', 'calc', 'defects', 'valves', 'photos', 'test', 'finish', 'materials'].find(
      (id) => id.toLocaleLowerCase('ru').includes(query),
    );
    if (section) {
      navigateToSection(section);
      return;
    }
    if ([report.number, report.address, report.date].some((value) => value.toLocaleLowerCase('ru').includes(query))) {
      navigateToSection('main');
      return;
    }
    if (reports.some((item) => matchesHistory(item, query))) {
      window.location.assign(`/vdgo/?view=history&q=${encodeURIComponent(query)}`);
      return;
    }
    setSearchMessage('Ничего не найдено');
  };

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchMessage('');
    setQueryInput(event.currentTarget.value.trim());
  };

  const statusLabel =
    healthState === 'checking'
      ? 'Проверяем сервисы…'
      : healthState === 'ok' && dbState !== 'error'
        ? 'Сервисы работают'
        : 'Проверьте сервисы';

  return (
    <header className="topbar">
      <form className="search" role="search" onSubmit={handleSearchSubmit}>
        <span aria-hidden="true">⌕</span>
        <input
          name="query"
          type="search"
          placeholder={historyActive ? 'Поиск по номеру, дате или имени файла…' : 'Поиск по адресу, номеру и разделам…'}
          aria-label={historyActive ? 'Поиск по истории документов' : 'Поиск по адресу, номеру и разделам'}
          defaultValue={historyActive ? initialHistoryQuery : undefined}
          value={queryInput}
          onChange={handleQueryChange}
        />
        <button title="Найти" aria-label="Найти">
          ↵
        </button>
        <output aria-live="polite">{searchMessage}</output>
      </form>
      <button className="service-status" onClick={() => void refreshStatus()} title={health?.database?.message || 'Обновить состояние сервисов'}>
        <i className={healthState} />
        {statusLabel}
      </button>
      <span className="avatar" aria-hidden="true">
        ВД
      </span>
      <span>ВДГО</span>
    </header>
  );
}
