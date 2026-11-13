import { useCallback } from 'react';

interface SidebarProps {
  historyActive: boolean;
  onNavigate: (page: string) => void;
}

export function Sidebar({ historyActive, onNavigate }: SidebarProps) {
  const handleNav = useCallback((page: string) => {
    onNavigate(page);
  }, [onNavigate]);

  return (
    <aside className="app-sidebar">
      <a className="sidebar-brand" href="#" onClick={(e) => { e.preventDefault(); onNavigate('dashboard'); }} aria-label="Профит — рабочий стол">
        <svg viewBox="0 0 32 36" width="29" height="33" aria-hidden="true">
          <path fill="#e0e0e0" d="M19 1c1 8-7 10-7 17 0 2 1 3 2 4-5-1-8-4-7-8C9 9 15 6 19 1Z" />
          <path fill="#b0b0b0" d="M21 12c7 5 9 10 6 16-2 4-6 6-11 7 4-3 5-6 3-9-1-2-4-3-4-6 0-3 3-6 6-8Z" />
          <path fill="#d0d0d0" d="M6 19c0 5 6 7 7 11l-2 4C5 31 2 26 6 19Z" />
        </svg>
        <span className="sidebar-brand-name">PROFIT</span>
      </a>
      <nav className="sidebar-nav" aria-label="Модули ПРОФИТ">
        <button className="sidebar-link" onClick={() => handleNav('dashboard')} aria-current={historyActive ? undefined : 'page'}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m3 10 9-7 9 7v10h-6v-6H9v6H3z" />
          </svg>
          Рабочий стол
        </button>
        <button className="sidebar-link" onClick={() => handleNav('conclusion')} aria-current={historyActive ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6" />
          </svg>
          Заключение
        </button>
        <button className="sidebar-link" onClick={() => handleNav('cad-schemes')}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 11l5-4 4 4 5-7 4 4M4 12v8h16V9M9 20v-5h5v5" />
          </svg>
          Схемы домов
        </button>
        <button className="sidebar-link" onClick={() => handleNav('archive')}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 4h18v5H3zm2 5v11h14V9M10 13h4" />
          </svg>
          Архив
        </button>
        <button className="sidebar-link" onClick={() => handleNav('settings')}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-5 2v4" />
          </svg>
          Настройки
        </button>
      </nav>
    </aside>
  );
}
