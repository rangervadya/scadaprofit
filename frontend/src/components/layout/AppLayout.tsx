import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useAuth } from '../../lib/auth';

export function AppLayout() {
  const location = useLocation();
  const { refresh } = useAuth();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    void refresh();
    window.scrollTo({ top: 0 });
  }, [location.pathname, refresh]);

  // Close the mobile drawer on navigation, otherwise it covers the page you
  // just opened. Desktop ignores navOpen because the sidebar is always visible.
  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className={`app-shell ${navOpen ? 'app-shell--nav-open' : ''}`}>
      {navOpen ? (
        <button type="button" className="nav-overlay" aria-label="Закрыть меню" onClick={() => setNavOpen(false)} />
      ) : null}
      <Sidebar onCloseNav={() => setNavOpen(false)} />
      <div className="main">
        <Topbar onToggleNav={() => setNavOpen((open) => !open)} navOpen={navOpen} />
        <main className="page" id="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
