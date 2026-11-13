export type ServiceState = 'checking' | 'ok' | 'error' | 'not-configured' | 'unknown';

export type HealthResponse = {
  status?: string;
  backend?: string;
  database?: { status?: string; configured?: boolean; message?: string };
  version?: string;
};

export type ReportRun = {
  id: number;
  created_at: string | null;
  report_number: string;
  report_date: string;
  output_format: string;
  page_count: number;
  output_filename: string;
};

export type ProgressEntry = { filled: number; total: number };

export type ReportSection = [string, string];

export const reportSections: ReportSection[] = [
  ['main', 'Основные данные'],
  ['people', 'Заказчик и специалисты'],
  ['calc', 'УЗТ и ресурс'],
  ['defects', 'Дефекты'],
  ['valves', 'Арматура и проверки'],
  ['photos', 'Фото и приложения'],
  ['test', 'Герметичность'],
  ['finish', 'Контроль перед выпуском'],
  ['materials', 'Схемы и акты'],
];
