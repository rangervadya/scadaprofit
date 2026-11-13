import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useAuth } from '../../lib/auth';

export function AppLayout() {
  const location = useLocation();
  const { refresh } = useAuth();

  useEffect(() => {
    void refresh();
    window.scrollTo({ top: 0 });
  }, [location.pathname, refresh]);

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <Topbar />
        <main className="page" id="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}