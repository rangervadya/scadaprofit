import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { BrandMark, Icon } from '../ui/Icon';
import { useAuth } from '../../lib/auth';
import { STAFF_ROLES } from '../../lib/roles';
import { useMediaQuery } from '../../lib/useMediaQuery';
import type { SessionUser } from '../../lib/types';

export type NavItem = {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
  roles?: SessionUser['role'][];
};

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Рабочий стол', icon: 'home', end: true },
  { to: '/conclusion', label: 'Заключение', icon: 'doc', roles: STAFF_ROLES },
  { to: '/schemes', label: 'Схемы домов', icon: 'scheme', roles: STAFF_ROLES },
  { to: '/archive', label: 'Архив', icon: 'archive', roles: STAFF_ROLES },
  { to: '/team', label: 'Команда', icon: 'team' },
  { to: '/cad', label: 'CAD-редактор', icon: 'cad', roles: STAFF_ROLES },
  { to: '/settings', label: 'Настройки', icon: 'settings', roles: STAFF_ROLES },
];

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

export function useActiveNav(): NavItem | undefined {
  const location = useLocation();
  return NAV_ITEMS.find((item) => (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)));
}

const COLLAPSED_KEY = 'profit.sidebar.collapsed';

export function Sidebar({ onCloseNav }: { onCloseNav?: () => void }) {
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  // Below 760px the sidebar is a drawer: collapsing it there just hides the
  // labels and leaves an unreadable icon strip, so the toggle closes instead.
  const isMobile = useMediaQuery('(max-width: 760px)');
  const isCollapsed = collapsed && !isMobile;

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    if (isMobile) {
      document.documentElement.style.removeProperty('--sidebar-width');
      return;
    }
    document.documentElement.style.setProperty('--sidebar-width', collapsed ? '76px' : '248px');
    return () => {
      document.documentElement.style.removeProperty('--sidebar-width');
    };
  }, [collapsed, isMobile]);

  const toggle = () => {
    if (isMobile) {
      onCloseNav?.();
      return;
    }
    setCollapsed((value) => !value);
  };
  const toggleLabel = isMobile ? 'Закрыть меню' : collapsed ? 'Развернуть меню' : 'Свернуть меню';

  return (
    <aside className={`sidebar ${isCollapsed ? 'sidebar--collapsed' : ''}`}>
      <div className="sidebar__head">
        <NavLink to="/" className="sidebar__brand" title="ПРОФИТ — на главную">
          <span className="sidebar__mark">
            <BrandMark size={20} />
          </span>
          <span className="sidebar__brand-name">ПРОФИТ</span>
        </NavLink>
        <button
          type="button"
          className="sidebar__toggle"
          onClick={toggle}
          aria-label={toggleLabel}
          aria-expanded={isMobile ? true : !collapsed}
          title={toggleLabel}
        >
          <Icon name={isMobile ? 'x' : collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
        </button>
      </div>
      <p className="sidebar__caption">Инженерные сервисы</p>
      <nav className="sidebar__nav" aria-label="Модули ПРОФИТ">
        {NAV_ITEMS.filter((item) => !item.roles || (user && item.roles.includes(user.role))).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className="sidebar__link"
            title={isCollapsed ? item.label : undefined}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar__footer">
        {user ? (
          <>
            <div
              className="sidebar__user"
              title={collapsed ? `${user.displayName || user.username} · ${user.roleName}` : undefined}
            >
              <span className="sidebar__avatar">{initials(user.displayName || user.username)}</span>
              <span className="sidebar__user-copy">
                <span className="sidebar__user-name">{user.displayName || user.username}</span>
                <span className="sidebar__user-role">{user.roleName}</span>
              </span>
            </div>
            <button
              type="button"
              className="sidebar__logout"
              onClick={() => void logout()}
              title="Выйти из аккаунта"
              aria-label="Выйти из аккаунта"
            >
              <Icon name="logout" size={17} />
              <span>Выйти из аккаунта</span>
            </button>
          </>
        ) : (
          <NavLink to="/login" className="sidebar__link">
            <Icon name="logout" />
            <span>Войти</span>
          </NavLink>
        )}
      </div>
    </aside>
  );
}
