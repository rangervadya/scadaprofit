import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { useHealth } from '../../lib/health';
import { useActiveNav } from './Sidebar';
import { useAuth } from '../../lib/auth';

const stateLabel = (online: boolean | null, loading: boolean): string => {
  if (loading) return 'Проверка сервисов';
  if (online === null) return 'Нет связи';
  return online ? 'Сервисы доступны' : 'Сервис недоступен';
};

export function Topbar({ onToggleNav, navOpen = false }: { onToggleNav?: () => void; navOpen?: boolean }) {
  const { data, loading, error } = useHealth();
  const { user } = useAuth();
  const isFitter = user?.role === 'fitter';
  const location = useLocation();
  const active = useActiveNav();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  useEffect(() => setQuery(''), [location.pathname]);

  const online = !error && data?.ok !== false;

  return (
    <header className="topbar">
      <button
        type="button"
        className="topbar__icon mobile-only"
        aria-label={navOpen ? 'Закрыть меню' : 'Открыть меню'}
        aria-expanded={navOpen}
        onClick={onToggleNav}
      >
        <Icon name={navOpen ? 'x' : 'menu'} />
      </button>
      {!isFitter ? <form
        className="searchbox"
        role="search"
        onSubmit={event => {
          event.preventDefault();
          const value = query.trim();
          if (!value) return;
          navigate(`/schemes?q=${encodeURIComponent(value)}`);
        }}
      >
        <Icon name="search" />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Поиск по адресам и схемам…"
          aria-label="Глобальный поиск"
        />
        <kbd>Enter</kbd>
      </form> : null}
      <span className="topbar__spacer" />
      {!isFitter ? <>
        <Link to="/settings" className="status-pill" title={error || data?.localRecognition?.mode || 'Состояние сервисов'}>
          <span className={`status-dot ${loading ? 'status-dot--checking' : online ? 'status-dot--ok' : 'status-dot--error'}`} />
          {stateLabel(online, loading)}
        </Link>
        <Link to="/settings" className="topbar__icon" aria-label="Настройки">
          <Icon name="settings" />
        </Link>
      </> : null}
      <span className="visually-hidden" aria-live="polite">{active?.label || 'Раздел'}</span>
    </header>
  );
}
