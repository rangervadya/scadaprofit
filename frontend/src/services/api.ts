import type { HealthResponse, ReportRun } from '../types';

const BASE = '/vdgo';

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`API вернул HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>('/api/health');
}

export async function fetchReports(): Promise<{ items?: ReportRun[] }> {
  return fetchJson<{ items?: ReportRun[] }>('/api/reports');
}
