import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { Spinner, ToastProvider } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import type { SessionUser } from './lib/types';
import './styles/index.css';

const lazyPage = (loader: () => Promise<Record<string, unknown>>, name: string) =>
  lazy(async () => ({ default: (await loader())[name] as React.ComponentType }));

const LoginPage = lazyPage(() => import('./pages/LoginPage'), 'LoginPage');
const DashboardPage = lazyPage(() => import('./pages/DashboardPage'), 'DashboardPage');
const ConclusionPage = lazyPage(() => import('./pages/ConclusionPage'), 'ConclusionPage');
const SchemesPage = lazyPage(() => import('./pages/SchemesPage'), 'SchemesPage');
const SchemeDetailPage = lazyPage(() => import('./pages/SchemeDetailPage'), 'SchemeDetailPage');
const ArchivePage = lazyPage(() => import('./pages/ArchivePage'), 'ArchivePage');
const TeamPage = lazyPage(() => import('./pages/TeamPage'), 'TeamPage');
const CadPage = lazyPage(() => import('./pages/CadPage'), 'CadPage');
const CadEditorPage = lazyPage(() => import('./pages/CadEditorPage'), 'CadEditorPage');
const SettingsPage = lazyPage(() => import('./pages/SettingsPage'), 'SettingsPage');

function PageFallback() {
  return (
    <div className="loading" style={{ minHeight: '40vh' }}>
      <Spinner />
      <span>Загружаем раздел…</span>
    </div>
  );
}

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

function RequireRole({ children, roles }: { children: React.ReactNode; roles: SessionUser['role'][] }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const STAFF_ROLES: SessionUser['role'][] = ['receiver', 'supervisor', 'developer'];

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
          <Suspense fallback={<PageFallback />}>
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
              <Route path="/conclusion" element={<RequireRole roles={STAFF_ROLES}><ConclusionPage /></RequireRole>} />
              <Route path="/schemes" element={<RequireRole roles={STAFF_ROLES}><SchemesPage /></RequireRole>} />
              <Route path="/schemes/:jobId" element={<RequireRole roles={STAFF_ROLES}><SchemeDetailPage /></RequireRole>} />
              <Route path="/archive" element={<RequireRole roles={STAFF_ROLES}><ArchivePage /></RequireRole>} />
              <Route path="/team" element={<TeamPage />} />
              <Route path="/cad" element={<RequireRole roles={STAFF_ROLES}><CadPage /></RequireRole>} />
              <Route path="/cad/:id" element={<RequireRole roles={STAFF_ROLES}><CadEditorPage /></RequireRole>} />
              <Route path="/settings" element={<RequireRole roles={STAFF_ROLES}><SettingsPage /></RequireRole>} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
          </Suspense>
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