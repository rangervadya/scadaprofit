import { useEffect } from 'react';

export function useWorkforceUpdates(enabled: boolean, reload: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const stream = new EventSource('/api/workforce/events');
    let pending: number | undefined;
    const schedule = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(reload, 120);
    };
    const recover = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    stream.addEventListener('changed', schedule);
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', recover);
    const fallback = window.setInterval(recover, 8000);
    return () => {
      stream.close();
      window.clearTimeout(pending);
      window.clearInterval(fallback);
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [enabled, reload]);
}
