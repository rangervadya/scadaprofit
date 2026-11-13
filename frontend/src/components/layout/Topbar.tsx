import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { useHealth } from '../../lib/health';
import { useActiveNav } from './Sidebar';

const stateLabel = (online: boolean | null, loading: boolean): string => {
  if (loading) return 'Проверка сервисов';
  if (online === null) return 'Нет связи';
  return online ? 'Сервисы доступны' : 'Сервис недоступен';
};

export function Topbar() {
  const { data, loading, error } = useHealth();
  const location = useLocation();
  const active = useActiveNav();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  useEffect(() => setQuery(''), [location.pathname]);

  const online = !error && data?.ok !== false;

  return (
    <header className="topbar">
      <Link to="/" className="topbar__icon mobile-only" aria-label="На главную">
        <Icon name="menu" />
      </Link>
      <form
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
      </form>
      <span className="topbar__spacer" />
      <Link to="/settings" className="status-pill" title={error || data?.localRecognition?.mode || 'Состояние сервисов'}>
        <span className={`status-dot ${loading ? 'status-dot--checking' : online ? 'status-dot--ok' : 'status-dot--error'}`} />
        {stateLabel(online, loading)}
      </Link>
      <Link to="/settings" className="topbar__icon" aria-label="Настройки">
        <Icon name="settings" />
      </Link>
      <span className="visually-hidden" aria-live="polite">{active?.label || 'Раздел'}</span>
    </header>
  );
}