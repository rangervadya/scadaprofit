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
      if (stream.readyState !== EventSource.OPEN && document.visibilityState === 'visible') schedule();
    };
    stream.addEventListener('changed', schedule);
    window.addEventListener('focus', schedule);
    const fallback = window.setInterval(recover, 5000);
    return () => {
      stream.close();
      window.clearTimeout(pending);
      window.clearInterval(fallback);
      window.removeEventListener('focus', schedule);
    };
  }, [enabled, reload]);
}
