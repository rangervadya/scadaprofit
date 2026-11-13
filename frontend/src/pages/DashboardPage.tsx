import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import { Badge, Card, Empty, Loading } from '../components/ui';
import { healthApi, workforceApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useHealth } from '../lib/health';
import { formatDateTime, formatShortDate, taskStatusLabel } from '../lib/format';
import type { ReportRun, WorkforceTask } from '../lib/types';

type QuickLink = { to: string; title: string; text: string; icon: string };

const QUICK_LINKS: QuickLink[] = [
  { to: '/conclusion', title: 'Заключение', text: 'Заполнить форму и выгрузить PDF или Word', icon: 'doc' },
  { to: '/schemes', title: 'Схемы домов', text: 'Загрузить эскиз и проверить CAD-схему', icon: 'scheme' },
  { to: '/cad', title: 'CAD-редактор', text: 'Нарисовать или доработать схему вручную', icon: 'cad' },
  { to: '/team', title: 'Команда', text: 'Задания, отчёты слесарей и дефекты', icon: 'team' },
  { to: '/archive', title: 'Архив', text: 'История заключений и чертежей', icon: 'archive' },
  { to: '/settings', title: 'Настройки', text: 'Эталонный шаблон и диагностика', icon: 'settings' },
];

export function DashboardPage() {
  const { user } = useAuth();
  const health = useHealth();
  const [reports, setReports] = useState<ReportRun[]>([]);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<WorkforceTask[]>([]);
  const [tasksError, setTasksError] = useState<string | null>(null);

  useEffect(() => {
    healthApi.reports()
      .then(data => setReports(Array.isArray(data.items) ? data.items : []))
      .catch(cause => setReportsError(cause instanceof Error ? cause.message : 'Не удалось загрузить историю'));
    if (user) {
      workforceApi.tasks()
        .then(data => setTasks(data.tasks || []))
        .catch(cause => setTasksError(cause instanceof Error ? cause.message : 'Не удалось загрузить задания'));
    }
  }, [user]);

  const activeTasks = useMemo(
    () => tasks.filter(task => !['accepted', 'superseded'].includes(task.status)),
    [tasks],
  );
  const myTasks = useMemo(
    () => (user?.role === 'fitter' ? tasks.filter(task => task.assignedTo === user.id) : activeTasks),
    [tasks, user],
  );

  return (
    <>
      <section className="hero">
        <div>
          <p className="hero__eyebrow">{new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1 className="hero__title">
            {user ? `Здравствуйте, ${user.displayName.split(' ')[0] || user.displayName}` : 'Рабочее место инженера'}
          </h1>
          <p className="hero__text">
            {user?.role === 'fitter'
              ? 'Здесь ваши назначенные дома: отмечайте этапы обхода и отправляйте эскизы и фотографии дефектов.'
              : 'Единый контур: заключения, ручные схемы, CAD-редактор, архив и приёмка работ слесарей.'}
          </p>
          <div className="hero__actions">
            <Link to="/conclusion" className="btn btn--primary"><Icon name="doc" /> Открыть заключение</Link>
            <Link to="/schemes" className="btn"><Icon name="upload" /> Загрузить схему</Link>
            <Link to="/team" className="btn"><Icon name="team" /> Задания и отчёты</Link>
          </div>
        </div>
        <div className="hero__aside">
          <div className="hero__metric">
            <div className="hero__metric-value">{reports.length}</div>
            <div className="hero__metric-label">Заключений сформировано</div>
          </div>
          <div className="hero__metric">
            <div className="hero__metric-value">{activeTasks.length}</div>
            <div className="hero__metric-label">Активных заданий</div>
          </div>
        </div>
      </section>

      <div className="quick-grid">
        {QUICK_LINKS.map(link => (
          <Link key={link.to} to={link.to} className="quick-card">
            <span className="quick-card__icon"><Icon name={link.icon} /></span>
            <span className="quick-card__title">{link.title}</span>
            <span className="quick-card__text">{link.text}</span>
          </Link>
        ))}
      </div>

      <div className="split">
        <Card
          title={user?.role === 'fitter' ? 'Мои задания' : 'Ближайшие задания'}
          actions={<Link to="/team" className="btn btn--ghost btn--sm">Все задания <Icon name="chevronRight" /></Link>}
          flush
        >
          {tasksError ? (
            <div style={{ padding: 16 }}><Badge tone="danger">{tasksError}</Badge></div>
          ) : myTasks.length === 0 ? (
            <Empty icon="team" title="Заданий пока нет">Назначьте дом слесарю в разделе «Команда».</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Адрес</th><th>Дата</th><th>Статус</th></tr>
                </thead>
                <tbody>
                  {myTasks.slice(0, 6).map(task => (
                    <tr key={task.id}>
                      <td>
                        <Link to={`/team?task=${task.id}`}>{task.street}, {task.address}</Link>
                        <div className="muted" style={{ fontSize: 11 }}>{task.assignedName}</div>
                      </td>
                      <td className="nowrap">{formatShortDate(task.scheduledDate)}</td>
                      <td><Badge tone={task.status === 'processing_failed' ? 'danger' : task.status === 'accepted' ? 'success' : 'info'}>{taskStatusLabel(task.status)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Последние заключения"
          actions={<Link to="/archive" className="btn btn--ghost btn--sm">Архив <Icon name="chevronRight" /></Link>}
          flush
        >
          {reportsError ? (
            <div style={{ padding: 16 }}><Badge tone="warn">{reportsError}</Badge></div>
          ) : reports.length === 0 ? (
            <Empty icon="archive" title="История пуста">Сформируйте первое заключение в разделе «Заключение».</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Номер</th><th>Дата</th><th>Формат</th><th>Создано</th></tr>
                </thead>
                <tbody>
                  {reports.slice(0, 6).map(report => (
                    <tr key={report.id}>
                      <td className="mono">{report.report_number || '—'}</td>
                      <td className="nowrap">{report.report_date || '—'}</td>
                      <td><Badge plain>{report.output_format?.toUpperCase() || '—'}</Badge></td>
                      <td className="nowrap muted">{formatDateTime(report.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="Состояние контура">
        {health.loading ? (
          <Loading>Проверяем сервисы…</Loading>
        ) : health.error ? (
          <div className="alert alert--danger"><Icon name="alert" /><span>{health.error}</span></div>
        ) : (
          <div className="grid grid--3">
            <div className="stat">
              <span className="stat__label"><span className="stat__icon"><Icon name="server" /></span> Основной сервис</span>
              <span className="stat__value" style={{ fontSize: 16 }}>{health.data?.mode || 'app'}</span>
              <span className="stat__hint">{health.data?.version || 'версия не указана'}</span>
            </div>
            <div className="stat">
              <span className="stat__label"><span className="stat__icon"><Icon name="sparkles" /></span> Распознавание</span>
              <span className="stat__value" style={{ fontSize: 16 }}>{health.data?.localRecognition?.mode || '—'}</span>
              <span className="stat__hint">Локальные модели, облако отключено</span>
            </div>
            <div className="stat">
              <span className="stat__label"><span className="stat__icon"><Icon name="doc" /></span> Эталонный шаблон</span>
              <span className="stat__value" style={{ fontSize: 16 }}>{health.data?.drawingTemplateConfigured ? 'Загружен' : 'Не загружен'}</span>
              <span className="stat__hint">Управляется в настройках</span>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}