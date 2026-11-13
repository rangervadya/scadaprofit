import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { Spinner, ToastProvider } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { ArchivePage } from './pages/ArchivePage';
import { CadEditorPage } from './pages/CadEditorPage';
import { CadPage } from './pages/CadPage';
import { ConclusionPage } from './pages/ConclusionPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { SchemeDetailPage } from './pages/SchemeDetailPage';
import { SchemesPage } from './pages/SchemesPage';
import { SettingsPage } from './pages/SettingsPage';
import { TeamPage } from './pages/TeamPage';
import './styles/index.css';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="loading" style={{ minHeight: '100vh' }}>
        <Spinner />
        <span>Проверяем сессию…</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function NotFoundPage() {
  return (
    <div className="stack" style={{ justifyItems: 'center', textAlign: 'center', padding: '60px 0' }}>
      <h1>404</h1>
      <p className="muted">Страница не найдена.</p>
      <a className="btn btn--primary" href={import.meta.env.BASE_URL}>На рабочий стол</a>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <AppLayout />
                </RequireAuth>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="/conclusion" element={<ConclusionPage />} />
              <Route path="/schemes" element={<SchemesPage />} />
              <Route path="/schemes/:jobId" element={<SchemeDetailPage />} />
              <Route path="/archive" element={<ArchivePage />} />
              <Route path="/team" element={<TeamPage />} />
              <Route path="/cad" element={<CadPage />} />
              <Route path="/cad/:id" element={<CadEditorPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Root container is missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);