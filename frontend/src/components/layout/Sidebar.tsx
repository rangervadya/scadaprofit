import { NavLink, useLocation } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { useAuth } from '../../lib/auth';
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
  { to: '/conclusion', label: 'Заключение', icon: 'doc' },
  { to: '/schemes', label: 'Схемы домов', icon: 'scheme' },
  { to: '/archive', label: 'Архив', icon: 'archive' },
  { to: '/team', label: 'Команда', icon: 'team' },
  { to: '/cad', label: 'CAD-редактор', icon: 'cad' },
  { to: '/settings', label: 'Настройки', icon: 'settings' },
];

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() || '')
    .join('');
}

export function useActiveNav(): NavItem | undefined {
  const location = useLocation();
  return NAV_ITEMS.find(item => (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)));
}

export function Sidebar({ badges }: { badges?: Partial<Record<string, number>> }) {
  const { user, logout } = useAuth();
  return (
    <aside className="sidebar">
      <NavLink to="/" className="sidebar__brand">
        <span className="sidebar__mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 20V6M4 20h16M8 20v-6h4v6M8 10h4M16 20v-9" />
          </svg>
        </span>
        <span>ПРОФИТ</span>
      </NavLink>
      <p className="sidebar__caption">Инженерные сервисы</p>
      <nav className="sidebar__nav" aria-label="Модули ПРОФИТ">
        {NAV_ITEMS.filter(item => !item.roles || (user && item.roles.includes(user.role))).map(item => {
          const count = badges?.[item.to];
          return (
            <NavLink key={item.to} to={item.to} end={item.end} className="sidebar__link">
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {count ? <span className="sidebar__badge">{count > 99 ? '99+' : count}</span> : null}
            </NavLink>
          );
        })}
      </nav>
      <div className="sidebar__footer">
        {user ? (
          <>
            <div className="sidebar__user">
              <span className="sidebar__avatar">{initials(user.displayName || user.username)}</span>
              <span className="sidebar__user-copy">
                <span className="sidebar__user-name">{user.displayName || user.username}</span>
                <span className="sidebar__user-role">{user.roleName}</span>
              </span>
            </div>
            <button type="button" className="sidebar__logout" onClick={() => void logout()}>
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