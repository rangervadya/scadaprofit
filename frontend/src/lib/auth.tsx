import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { authApi } from './api';
import type { SessionUser } from './types';

type AuthState = {
  user: SessionUser | null;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  error: null,
  login: async () => {
    throw new Error('AuthProvider missing');
  },
  logout: async () => {},
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await authApi.me();
      setUser(data.user);
      setError(null);
    } catch (cause) {
      setUser(null);
      setError(cause instanceof Error ? cause.message : 'Не удалось проверить сессию');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const data = await authApi.login(username, password);
    setUser(data.user);
    setError(null);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(() => ({ user, loading, error, login, logout, refresh }), [user, loading, error, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}