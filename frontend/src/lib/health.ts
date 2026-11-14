import { useCallback, useEffect, useState } from 'react';
import { healthApi } from './api';
import type { HealthResponse } from './types';

export type HealthState = {
  data: HealthResponse | null;
  loading: boolean;
  error: string | null;
};

const initial: HealthState = { data: null, loading: true, error: null };

export function useHealth(): HealthState & { reload: () => void } {
  const [state, setState] = useState<HealthState>(initial);

  const load = useCallback(async () => {
    setState(current => ({ ...current, loading: true }));
    try {
      const data = await healthApi.main();
      setState({ data, loading: false, error: null });
    } catch (cause) {
      setState({ data: null, loading: false, error: cause instanceof Error ? cause.message : 'Сервис недоступен' });
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 45_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return { ...state, reload: () => void load() };
}