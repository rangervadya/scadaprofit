export function matchesHistory(item: { report_number: string; report_date: string; output_filename: string }, query: string) {
  return [item.report_number, item.report_date, item.output_filename].some((value) => value?.toLocaleLowerCase('ru').includes(query));
}

export function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}
