import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BrandMark, Icon } from '../components/ui/Icon';
import { Button, Field, Spinner } from '../components/ui';
import { authApi } from '../lib/api';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
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
        if (status.setupRequired) setMode('setup');
      })
      .catch(() => setMode('login'));
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
        await login(username, password);
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
      <main className="auth__main">
        <form className="auth__card" onSubmit={submit}>
          <div className="row" style={{ gap: 10, alignItems: 'center', justifyContent: 'center' }}>
            <BrandMark size={30} />
            <span style={{ fontSize: 17, fontWeight: 750, letterSpacing: '-0.01em' }}>ПРОФИТ</span>
          </div>

          <div style={{ textAlign: 'center' }}>
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

        </form>
      </main>
    </div>
  );
}