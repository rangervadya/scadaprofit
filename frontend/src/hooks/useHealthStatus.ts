import { useCallback, useEffect, useState } from 'react';
import type { HealthResponse, ReportRun, ServiceState } from '../types';
import { fetchHealth, fetchReports } from '../services/api';

export function useHealthStatus() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthState, setHealthState] = useState<ServiceState>('checking');
  const [dbState, setDbState] = useState<ServiceState>('checking');
  const [reports, setReports] = useState<ReportRun[]>([]);
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading');

  const refreshStatus = useCallback(async () => {
    try {
      const data = await fetchHealth();
      setHealth(data);
      setHealthState(data.backend === 'ok' ? 'ok' : 'error');
      const db = data.database?.status;
      setDbState(db === 'ok' ? 'ok' : db === 'not-configured' ? 'not-configured' : 'error');

      try {
        const recent = await fetchReports();
        setReports(recent.items ?? []);
        setHistoryState('ready');
      } catch {
        setHistoryState('error');
      }
    } catch {
      setHealthState('error');
      setDbState('unknown');
      setHistoryState('error');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const id = window.setInterval(() => void refreshStatus(), 15000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  return { health, healthState, dbState, reports, historyState, refreshStatus };
}
