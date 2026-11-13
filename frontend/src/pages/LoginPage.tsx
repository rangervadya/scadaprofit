import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BrandMark, Icon } from '../components/ui/Icon';
import { Button, Field, Spinner } from '../components/ui';
import { authApi } from '../lib/api';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [setupRequired, setSetupRequired] = useState(false);
  const [mode, setMode] = useState<'login' | 'setup'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authApi
      .status()
      .then(status => {
        setSetupRequired(status.setupRequired);
        if (status.setupRequired) setMode('setup');
      })
      .catch(() => setSetupRequired(false));
  }, []);

  if (loading) {
    return (
      <div className="loading" style={{ minHeight: '100vh' }}>
        <Spinner />
        <span>Проверяем сессию…</span>
      </div>
    );
  }

  if (user) return <Navigate to="/" replace />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') {
        await authApi.setup(username, displayName, password);
      } else {
        await login(username, password);
      }
      navigate('/', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <aside className="auth__aside">
        <div>
          <div className="auth__brand">
            <BrandMark size={32} />
            <span>ПРОФИТ</span>
          </div>
          <div style={{ marginTop: 'clamp(32px, 8vh, 80px)' }}>
            <h1 className="auth__headline">Единая среда инженера ВДГО</h1>
            <p className="auth__text">
              Заключения, ручные схемы, CAD-редактор, архив и приёмка работ слесарей — в одном приложении без
              перезагрузок страниц.
            </p>
            <div className="auth__points">
              <span className="auth__point"><Icon name="check" /> Полная форма технического заключения</span>
              <span className="auth__point"><Icon name="check" /> Импорт эскизов и проверка CAD-схем</span>
              <span className="auth__point"><Icon name="check" /> Задания, отчёты и дефекты в одном контуре</span>
            </div>
          </div>
        </div>
        <p style={{ color: '#8fa9ce', fontSize: 12 }}>Локальный контур · данные остаются на вашем сервере</p>
      </aside>

      <main className="auth__main">
        <form className="auth__card" onSubmit={submit}>
          <div>
            <h1>{mode === 'setup' ? 'Первичная настройка' : 'Вход в систему'}</h1>
            <p style={{ marginTop: 6 }}>
              {mode === 'setup'
                ? 'Создайте аккаунт разработчика — он получит полный доступ.'
                : 'Введите логин и пароль, выданные руководителем.'}
            </p>
          </div>

          {error ? <div className="auth__error" role="alert">{error}</div> : null}

          <Field label="Логин" required>
            <input
              className="input"
              value={username}
              onChange={event => setUsername(event.target.value)}
              autoComplete="username"
              required
              placeholder="ivan.petrov"
            />
          </Field>

          {mode === 'setup' ? (
            <Field label="Имя и фамилия" required>
              <input
                className="input"
                value={displayName}
                onChange={event => setDisplayName(event.target.value)}
                required
                placeholder="Иван Петров"
              />
            </Field>
          ) : null}

          <Field label="Пароль" required hint={mode === 'setup' ? 'Минимум 10 символов.' : undefined}>
            <input
              className="input"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
              required
              placeholder="••••••••••"
            />
          </Field>

          <Button type="submit" variant="primary" block disabled={busy}>
            {busy ? <Spinner light /> : <Icon name="logout" />}
            {mode === 'setup' ? 'Создать аккаунт и войти' : 'Войти'}
          </Button>

          {!setupRequired ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setMode(current => (current === 'login' ? 'setup' : 'login'));
                setError(null);
              }}
            >
              {mode === 'login' ? 'Первичная настройка системы' : 'Вернуться ко входу'}
            </button>
          ) : null}
        </form>
      </main>
    </div>
  );
}