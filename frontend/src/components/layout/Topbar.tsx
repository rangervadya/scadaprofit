import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { useHealth } from '../../lib/health';
import { hasPermission } from '../../lib/permissions.mjs';
import { useAuth } from '../../lib/auth';
import { useActiveNav } from './Sidebar';

export function Topbar({ onToggleNav, navOpen = false }: { onToggleNav?: () => void; navOpen?: boolean }) {
  const { data, loading, error } = useHealth();
  const { user } = useAuth();
  const location = useLocation();
  const active = useActiveNav();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const isFitter = user?.role === 'fitter';
  const canConfigure = hasPermission(user?.role, 'system:settings');

  useEffect(() => setQuery(''), [location.pathname]);

  const online = !error && data?.ok === true;
  const statusLabel = loading ? 'Проверка связи' : online ? 'Система доступна' : 'Нет связи с сервером';

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
      {!isFitter ? (
        <form
          className="searchbox"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const value = query.trim();
            if (!value) return;
            navigate(`/schemes?q=${encodeURIComponent(value)}`);
          }}
        >
          <Icon name="search" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по адресам и схемам…"
            aria-label="Глобальный поиск"
          />
          <kbd>Enter</kbd>
        </form>
      ) : null}
      <span className="topbar__spacer" />
      {isFitter ? null : (
        <Link
          to={canConfigure ? "/settings" : "/team"}
          className="status-pill"
          title={error || statusLabel}
        >
          <span
            className={`status-dot ${loading ? 'status-dot--checking' : online ? 'status-dot--ok' : 'status-dot--error'}`}
          />
          {statusLabel}
        </Link>
      )}
      {canConfigure ? (
        <Link to="/settings" className="topbar__icon" aria-label="Настройки">
          <Icon name="settings" />
        </Link>
      ) : null}
      <span className="visually-hidden" aria-live="polite">
        {active?.label || 'Раздел'}
      </span>
    </header>
  );
}
