export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatShortDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function isoDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 КБ';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}

export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function schemeStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'В очереди',
    queued: 'В очереди',
    processing: 'Обрабатывается',
    completed: 'Готово',
    failed: 'Ошибка',
  };
  return labels[status] || status;
}

export function taskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    assigned: 'Назначено',
    in_progress: 'Обход начат',
    house_visited: 'Дом пройден',
    at_office: 'В офисе',
    submitted: 'Эскиз отправлен',
    processing: 'CAD-обработка',
    pending_review: 'Готово к проверке',
    accepted: 'Принято',
    revision_requested: 'На исправление',
    processing_failed: 'Ошибка CAD',
    superseded: 'Заменено',
  };
  return labels[status] || status;
}

export function reviewStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending_review: 'Ждёт проверки',
    accepted: 'Принято',
    revision_requested: 'На исправление',
    superseded: 'Заменено',
  };
  return labels[status] || status;
}

export function todayLabel(): string {
  return new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function pluralizeCount(count: number, forms: [string, string, string]): string {
  return `${count} ${plural(count, forms[0], forms[1], forms[2])}`;
}