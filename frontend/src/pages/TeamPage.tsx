import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Loading,
  Modal,
  Spinner,
  useToast,
} from '../components/ui';
import { cadApi, workforceApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  formatDate,
  formatDateTime,
  formatShortDate,
  isoDate,
  pluralizeCount,
  reviewStatusLabel,
  taskStatusLabel,
} from '../lib/format';
import type {
  SessionUser,
  TaskStatus,
  WorkforceDefectReport,
  WorkforceOverview,
  WorkforceReport,
  WorkforceTask,
  WorkforceUser,
} from '../lib/types';

type Tab = 'tasks' | 'schedule' | 'overview' | 'inbox' | 'users' | 'credentials';

const ACTIVE_STATUSES: TaskStatus[] = ['assigned', 'in_progress', 'house_visited', 'at_office', 'submitted', 'processing', 'pending_review'];

function statusTone(status: string): 'success' | 'warn' | 'danger' | 'info' | 'default' {
  if (status === 'accepted') return 'success';
  if (status === 'revision_requested' || status === 'processing_failed') return 'danger';
  if (status === 'pending_review' || status === 'processing') return 'info';
  return 'warn';
}

function roleLabel(role: string): string {
  return { fitter: 'Слесарь', receiver: 'Приёмщик', supervisor: 'Руководитель', developer: 'Разработчик' }[role] || role;
}

type FolderState = {
  schemes: WorkforceReport[];
  defects: WorkforceDefectReport[];
  allAccepted: boolean;
  schemesReady: boolean;
  photosReady: boolean;
  unseenCount: number;
  ready: boolean;
  allAdded: boolean;
  photoCount: number;
};

function evaluateFolder(schemes: WorkforceReport[], defects: WorkforceDefectReport[], userId: string | null): FolderState {
  const allAccepted = [...schemes, ...defects].every(item => item.status === 'accepted');
  const schemesReady = schemes.every(item => Boolean(item.manualCadProjectId));
  const photosReady = defects.every(item => (item.photos || []).length > 0);
  const unseenCount = [...schemes, ...defects].filter(item => !item.seen && (userId === null || item.userId !== userId)).length;
  const allAdded = [...schemes, ...defects].length > 0 && [...schemes, ...defects].every(item => item.conclusionAddedAt);
  return {
    schemes,
    defects,
    allAccepted,
    schemesReady,
    photosReady,
    unseenCount,
    ready: schemes.length + defects.length > 0 && allAccepted && schemesReady && photosReady && unseenCount === 0,
    allAdded,
    photoCount: defects.reduce((sum, item) => sum + (item.photos || []).length, 0),
  };
}

export function TeamPage() {
  const { user } = useAuth();
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('tasks');
  const [tasks, setTasks] = useState<WorkforceTask[]>([]);
  const [reports, setReports] = useState<WorkforceReport[]>([]);
  const [defects, setDefects] = useState<WorkforceDefectReport[]>([]);
  const [users, setUsers] = useState<WorkforceUser[]>([]);
  const [overview, setOverview] = useState<WorkforceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(params.get('task'));
  const [selectedFolderTaskId, setSelectedFolderTaskId] = useState<string | null>(params.get('task'));
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [showUserForm, setShowUserForm] = useState(false);
  const [credentials, setCredentials] = useState<{ username: string; password: string; displayName?: string } | null>(null);

  const isFitter = user?.role === 'fitter';
  const canManage = user?.role === 'supervisor' || user?.role === 'developer';

  const load = useCallback(async () => {
    setError(null);
    try {
      const taskData = await workforceApi.tasks();
      setTasks(taskData.tasks || []);
      if (!isFitter) {
        const [reportData, defectData, overviewData, userData] = await Promise.all([
          workforceApi.reports(),
          workforceApi.defects(),
          workforceApi.overview(),
          workforceApi.users(),
        ]);
        setReports(reportData.reports || []);
        setDefects(defectData.reports || []);
        setOverview(overviewData);
        setUsers(userData.users || []);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить данные команды');
    } finally {
      setLoading(false);
    }
  }, [isFitter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!isFitter) void workforceApi.overview().then(setOverview).catch(() => {});
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [isFitter]);

  const folders = useMemo(() => {
    const map = new Map<string, { task: WorkforceTask | undefined; schemes: WorkforceReport[]; defects: WorkforceDefectReport[] }>();
    for (const task of tasks) map.set(task.id, { task, schemes: [], defects: [] });
    for (const report of reports) {
      const entry = map.get(report.taskId) || { task: undefined, schemes: [], defects: [] };
      entry.schemes.push(report);
      map.set(report.taskId, entry);
    }
    for (const defect of defects) {
      const entry = map.get(defect.taskId) || { task: undefined, schemes: [], defects: [] };
      entry.defects.push(defect);
      map.set(defect.taskId, entry);
    }
    return Array.from(map.entries())
      .filter(([, entry]) => entry.schemes.length + entry.defects.length > 0)
      .map(([taskId, entry]) => ({ taskId, task: entry.task, state: evaluateFolder(entry.schemes, entry.defects, user?.id || null) }));
  }, [tasks, reports, defects, user?.id]);

  const activeFolder = folders.find(folder => folder.taskId === selectedFolderTaskId) || null;
  const activeTask = tasks.find(task => task.id === selectedTaskId) || null;

  useEffect(() => {
    if (!activeFolder) return;
    const pending = [
      ...activeFolder.state.schemes.filter(item => !item.seen).map(item => workforceApi.seeReport(item.id)),
      ...activeFolder.state.defects.filter(item => !item.seen).map(item => workforceApi.seeDefect(item.id)),
    ];
    if (!pending.length) return;
    void Promise.all(pending).then(() => {
      setReports(current => current.map(item => ({ ...item, seen: true })));
      setDefects(current => current.map(item => ({ ...item, seen: true })));
    }).catch(() => {});
  }, [activeFolder?.taskId]);

  const selectFolder = (taskId: string) => {
    setSelectedFolderTaskId(taskId);
    setParams({ task: taskId });
  };

  const refresh = async (message?: string) => {
    await load();
    if (message) notify(message, 'success');
  };

  const mark = async (task: WorkforceTask, endpoint: 'start' | 'visit' | 'office') => {
    setBusy(true);
    try {
      if (endpoint === 'start') await workforceApi.startTask(task.id);
      if (endpoint === 'visit') await workforceApi.visitTask(task.id);
      if (endpoint === 'office') await workforceApi.officeTask(task.id);
      await refresh(endpoint === 'start' ? 'Обход начат' : endpoint === 'visit' ? 'Дом отмечен пройденным' : 'Отметка «в офисе» сохранена');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось обновить статус', 'error');
    } finally {
      setBusy(false);
    }
  };

  const addToConclusion = async (taskId: string) => {
    setBusy(true);
    try {
      const folder = folders.find(item => item.taskId === taskId);
      if (!folder) throw new Error('Папка не найдена.');
      await Promise.all(folder.state.schemes.map(async report => {
        if (!report.manualCadProjectId) {
          if (!report.schemeJobId) throw new Error(`Нет задания CAD для схемы ${report.street}, дом ${report.address}.`);
          const project = await cadApi.importJob(report.schemeJobId, `${report.street}, дом ${report.address}`);
          report.manualCadProjectId = project.project.id;
        }
      }));
      await workforceApi.addToConclusion(taskId);
      await refresh('Папка добавлена в заключение');
      setParams({ task: taskId });
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось перенести папку', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card><Loading>Загружаем данные команды…</Loading></Card>;

  if (error) {
    return (
      <div className="alert alert--danger">
        <Icon name="alert" />
        <div>
          <div style={{ fontWeight: 650 }}>{error}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => { setLoading(true); void load(); }}>Повторить</Button>
            <Link className="btn btn--sm" to="/login">Проверить сессию</Link>
          </div>
        </div>
      </div>
    );
  }

  const visibleTabs: Array<[Tab, string, boolean]> = isFitter
    ? [['tasks', 'Мои задания', true]]
    : [
        ['tasks', 'Задания', true],
        ['schedule', 'Планирование', true],
        ['overview', 'Обзор', true],
        ['inbox', `Приёмка${reports.length + defects.length ? ` · ${folders.length}` : ''}`, true],
        ['users', 'Пользователи', canManage],
        ['credentials', 'Учётные записи', canManage],
      ];

  return (
    <>
      <header className="page__header">
        <div>
          <p className="page__eyebrow">Работы</p>
          <h1>Команда</h1>
          <p className="page__subtitle">
            {isFitter
              ? 'Ваши назначенные дома, этапы обхода и отправка материалов.'
              : 'Задания слесарям, приёмка схем и фотографий дефектов, управление аккаунтами.'}
          </p>
        </div>
        <div className="page__actions">
          <Button icon="refresh" onClick={() => void refresh()} disabled={busy}>Обновить</Button>
          {!isFitter ? <Button variant="primary" icon="plus" onClick={() => setShowTaskForm(true)}>Назначить задание</Button> : null}
        </div>
      </header>

      <div className="tabs" role="tablist">
        {visibleTabs.filter(([, , visible]) => visible).map(([key, label]) => (
          <button key={key} type="button" role="tab" className="tabs__tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === 'tasks' ? (
        <div className="team-grid">
          <Card title={isFitter ? 'Мои дома' : 'Задания'} flush>
            {tasks.length === 0 ? (
              <Empty icon="team" title="Заданий нет">Назначьте первый дом слесарю.</Empty>
            ) : (
              <div className="card__body" style={{ maxHeight: 560, overflowY: 'auto' }}>
                <div className="team-list">
                  {tasks.map(task => {
                    const visible = isFitter ? task.assignedTo === user?.id : true;
                    if (!visible) return null;
                    return (
                      <button
                        key={task.id}
                        type="button"
                        className={`list-item ${selectedTaskId === task.id ? 'list-item--active' : ''}`}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <span className="list-item__main">
                          <span className="list-item__title">{task.street}, {task.address}</span>
                          <span className="list-item__meta">{task.assignedName} · {formatShortDate(task.scheduledDate)}</span>
                        </span>
                        <Badge tone={statusTone(task.status)}>{taskStatusLabel(task.status)}</Badge>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

          <TaskDetail
            task={activeTask}
            busy={busy}
            onMark={mark}
            onRefresh={refresh}
            canManage={!isFitter}
            currentUserId={user?.id || ''}
          />
        </div>
      ) : null}

      {tab === 'schedule' ? (
        <ScheduleTab
          tasks={tasks}
          users={users.filter(item => item.role === 'fitter' && item.active)}
          onCreated={() => void refresh('Задания назначены')}
          onError={message => notify(message, 'error')}
        />
      ) : null}

      {tab === 'overview' ? (
        <OverviewTab overview={overview} tasks={tasks} reports={reports} defects={defects} />
      ) : null}

      {tab === 'inbox' ? (
        <div className="team-grid">
          <Card title="Папки по адресам" flush>
            {folders.length === 0 ? (
              <Empty icon="folder" title="Материалов нет">Слесарь ещё не отправил схемы или дефекты.</Empty>
            ) : (
              <div className="card__body" style={{ maxHeight: 600, overflowY: 'auto' }}>
                <div className="team-list">
                  {folders.map(folder => {
                    const title = folder.task ? `${folder.task.street}, ${folder.task.address}` : folder.taskId;
                    const badge = folder.state.allAdded ? 'accepted' : folder.state.ready ? 'pending_review' : 'processing';
                    return (
                      <button
                        key={folder.taskId}
                        type="button"
                        className={`list-item ${selectedFolderTaskId === folder.taskId ? 'list-item--active' : ''}`}
                        onClick={() => selectFolder(folder.taskId)}
                      >
                        <span className="list-item__main">
                          <span className="list-item__title">{title}</span>
                          <span className="list-item__meta">
                            {pluralizeCount(folder.state.schemes.length, ['схема', 'схемы', 'схем'])} ·{' '}
                            {pluralizeCount(folder.state.defects.length, ['комплект', 'комплекта', 'комплектов'])} ·{' '}
                            {folder.state.photoCount} фото
                          </span>
                        </span>
                        <Badge tone={statusTone(badge)}>{badge === 'accepted' ? 'Добавлено' : badge === 'pending_review' ? 'Готово' : 'Проверка'}</Badge>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

          <div>
            {activeFolder ? (
              <FolderDetail
                folder={activeFolder}
                busy={busy}
                onRefresh={refresh}
                onAddToConclusion={addToConclusion}
              />
            ) : (
              <Card><Empty icon="folder" title="Выберите папку">Слева выберите адрес, чтобы проверить схемы и фотографии дефектов.</Empty></Card>
            )}
          </div>
        </div>
      ) : null}

      {tab === 'users' ? (
        <UsersTab
          users={users}
          canManage={canManage}
          onRefresh={refresh}
          onCreate={() => setShowUserForm(true)}
        />
      ) : null}

      {tab === 'credentials' ? (
        <CredentialsTab users={users} onReset={async id => {
          try {
            const result = await workforceApi.resetPassword(id);
            setCredentials(result.credentials);
            notify('Новый пароль выдан', 'success');
          } catch (cause) {
            notify(cause instanceof Error ? cause.message : 'Не удалось выдать пароль', 'error');
          }
        }} />
      ) : null}

      {showTaskForm ? (
        <TaskFormModal
          users={users.filter(item => item.role === 'fitter' && item.active)}
          onClose={() => setShowTaskForm(false)}
          onCreated={message => {
            setShowTaskForm(false);
            void refresh(message);
          }}
          onError={message => notify(message, 'error')}
        />
      ) : null}

      {showUserForm ? (
        <UserFormModal
          onClose={() => setShowUserForm(false)}
          onCreated={result => {
            setShowUserForm(false);
            setCredentials(result.credentials);
            void refresh('Аккаунт создан');
          }}
          onError={message => notify(message, 'error')}
        />
      ) : null}

      {credentials ? (
        <Modal
          title="Данные для входа"
          onClose={() => setCredentials(null)}
          footer={<Button variant="primary" onClick={() => setCredentials(null)}>Готово</Button>}
        >
          <div className="alert alert--warn"><Icon name="alert" /><span>Пароль показывается один раз. Сохраните его и передайте сотруднику.</span></div>
          <dl className="kv">
            <dt>Логин</dt><dd className="mono">{credentials.username}</dd>
            <dt>Пароль</dt><dd className="mono">{credentials.password}</dd>
          </dl>
        </Modal>
      ) : null}
    </>
  );
}

function TaskDetail({
  task,
  busy,
  onMark,
  onRefresh,
  canManage,
  currentUserId,
}: {
  task: WorkforceTask | null;
  busy: boolean;
  onMark: (task: WorkforceTask, endpoint: 'start' | 'visit' | 'office') => void;
  onRefresh: (message?: string) => Promise<void>;
  canManage: boolean;
  currentUserId: string;
}) {
  const { notify } = useToast();
  const [sketch, setSketch] = useState<File | null>(null);
  const [sketchNote, setSketchNote] = useState('');
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoNote, setPhotoNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setSketch(null);
    setSketchNote('');
    setPhotoFiles([]);
    setPhotoNote('');
  }, [task?.id]);

  if (!task) return <Card><Empty icon="team" title="Выберите задание">Слева выберите дом, чтобы увидеть этапы и отправить материалы.</Empty></Card>;

  const submitSketch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sketch) return;
    setSubmitting(true);
    try {
      await workforceApi.submitSketch(task.id, sketch, sketchNote);
      setSketch(null);
      setSketchNote('');
      notify('Эскиз отправлен', 'success');
      await onRefresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось отправить эскиз', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const submitDefects = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!photoFiles.length) return;
    setSubmitting(true);
    try {
      await workforceApi.submitDefects(task.id, photoFiles, photoNote);
      setPhotoFiles([]);
      setPhotoNote('');
      notify('Фотографии дефектов отправлены', 'success');
      await onRefresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось отправить фотографии', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const mine = canManage || task.assignedTo === currentUserId;
  const isFitterView = !canManage;

  return (
    <div className="stack">
      <Card
        title={
          <>
            <Icon name="building" /> {task.street}, дом {task.address}
          </>
        }
        actions={<Badge tone={statusTone(task.status)}>{taskStatusLabel(task.status)}</Badge>}
      >
        <div className="row row--wrap" style={{ marginBottom: 12 }}>
          <Button size="sm" disabled={busy || !['assigned', 'revision_requested'].includes(task.status)} onClick={() => onMark(task, 'start')}>Начать обход</Button>
          <Button size="sm" disabled={busy || !['assigned', 'in_progress'].includes(task.status)} onClick={() => onMark(task, 'visit')}>Дом пройден</Button>
          <Button size="sm" disabled={busy || task.status !== 'house_visited'} onClick={() => onMark(task, 'office')}>В офисе</Button>
        </div>
        <dl className="kv">
          <dt>Слесарь</dt><dd>{task.assignedName}</dd>
          <dt>Дата</dt><dd>{formatDate(task.scheduledDate)}</dd>
          <dt>Задание</dt><dd>{task.title}</dd>
          {task.instructions ? <><dt>Указания</dt><dd>{task.instructions}</dd></> : null}
          <dt>Материалы</dt><dd>{task.reportsCount} схем · {task.defectReportsCount} комплектов дефектов</dd>
        </dl>
        <div className="divider" style={{ margin: '14px 0' }} />
        <h4 style={{ marginBottom: 10 }}>Этапы работ</h4>
        <div className="timeline">
          {task.events.map((event, index) => (
            <div key={`${event.type}-${index}`} className={`timeline__item ${event.type === 'completed' ? 'timeline__item--done' : 'timeline__item--current'}`}>
              <span className="timeline__dot"><span className="timeline__line" /></span>
              <span className="timeline__body">
                <span className="timeline__label">{event.label || event.type}</span>
                <span className="timeline__meta">{formatDateTime(event.at)}{event.userName ? ` · ${event.userName}` : ''}</span>
              </span>
            </div>
          ))}
        </div>
      </Card>

      {isFitterView ? (
        <>
          <Card title="Отправить ручную схему">
            <form className="stack stack--sm" onSubmit={submitSketch}>
              <Field label="Фотография эскиза" required>
                <input className="input" type="file" accept="image/jpeg,image/png,image/webp,image/tiff" onChange={event => setSketch(event.target.files?.[0] || null)} required />
              </Field>
              <Field label="Комментарий">
                <textarea className="textarea" value={sketchNote} onChange={event => setSketchNote(event.target.value)} placeholder="Например, подъезд 1, ввод газа" />
              </Field>
              <div><Button type="submit" variant="primary" icon="upload" disabled={submitting || !sketch}>{submitting ? <Spinner light /> : null} Отправить эскиз</Button></div>
            </form>
          </Card>
          <Card title="Отправить фотографии дефектов">
            <form className="stack stack--sm" onSubmit={submitDefects}>
              <Field label="Фотографии" required hint="Можно выбрать несколько файлов.">
                <input className="input" type="file" accept="image/*" multiple onChange={event => setPhotoFiles(Array.from(event.target.files || []))} required />
              </Field>
              <Field label="Комментарий">
                <textarea className="textarea" value={photoNote} onChange={event => setPhotoNote(event.target.value)} placeholder="Опишите выявленные дефекты" />
              </Field>
              <div><Button type="submit" variant="primary" icon="camera" disabled={submitting || !photoFiles.length}>{submitting ? <Spinner light /> : null} Отправить фотографии</Button></div>
            </form>
          </Card>
        </>
      ) : (
        <Card title="Материалы слесаря" flush>
          {task.defectReports.length === 0 && task.reportsCount === 0 ? (
            <Empty icon="image" title="Материалов нет">Слесарь ещё не отправлял схемы или дефекты.</Empty>
          ) : (
            <div className="card__body stack">
              {task.defectReports.map(report => (
                <div key={report.id} className="list-item">
                  <span className="list-item__main">
                    <span className="list-item__title">{report.userName} · {report.photos.length} фото</span>
                    <span className="list-item__meta">{report.note || 'Без комментария'} · {formatDateTime(report.submittedAt)}</span>
                  </span>
                  <Badge tone={statusTone(report.status)}>{reviewStatusLabel(report.status)}</Badge>
                </div>
              ))}
              {task.reportsCount ? (
                <Link className="btn btn--sm" to="/team?task=" style={{ display: 'none' }} />
              ) : null}
            </div>
          )}
          {mine ? <p className="field__hint" style={{ padding: 12 }}>Полная приёмка — во вкладке «Приёмка».</p> : null}
        </Card>
      )}
    </div>
  );
}

function FolderDetail({
  folder,
  busy,
  onRefresh,
  onAddToConclusion,
}: {
  folder: { taskId: string; task: WorkforceTask | undefined; state: FolderState };
  busy: boolean;
  onRefresh: (message?: string) => Promise<void>;
  onAddToConclusion: (taskId: string) => void;
}) {
  const { notify } = useToast();
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [kind, setKind] = useState<'scheme' | 'defect'>('scheme');
  const [busyLocal, setBusyLocal] = useState(false);

  const review = async (status: 'accepted' | 'revision_requested') => {
    if (!reviewId) return;
    setBusyLocal(true);
    try {
      if (kind === 'scheme') await workforceApi.reviewReport(reviewId, status, comment);
      else await workforceApi.reviewDefect(reviewId, status, comment);
      setReviewId(null);
      setComment('');
      await onRefresh(status === 'accepted' ? 'Материал принят' : 'Возвращено на исправление');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось сохранить решение', 'error');
    } finally {
      setBusyLocal(false);
    }
  };

  const state = folder.state;

  return (
    <div className="stack">
      <Card
        title={
          <>
            <Icon name="folder" /> {folder.task ? `${folder.task.street}, дом ${folder.task.address}` : 'Папка адреса'}
          </>
        }
        actions={<Badge tone={state.allAdded ? 'success' : state.ready ? 'info' : 'warn'}>{state.allAdded ? 'Добавлено' : state.ready ? 'Готово' : 'На проверке'}</Badge>}
      >
        <div className="row row--wrap">
          <Button
            size="sm"
            disabled={busy || busyLocal || !state.ready || state.allAdded}
            variant="primary"
            onClick={() => onAddToConclusion(folder.taskId)}
          >
            Добавить всю папку в заключение
          </Button>
          {state.allAdded && folder.task ? (
            <Link className="btn btn--sm" to={`/conclusion?task=${encodeURIComponent(folder.task.id)}`}>Открыть заключение</Link>
          ) : null}
        </div>
        {!state.ready ? (
          <p className="field__hint" style={{ marginTop: 8 }}>
            Перенос станет доступен после проверки всех материалов: {state.allAccepted ? 'все приняты' : 'есть непринятые'}, {state.schemesReady ? 'CAD готов' : 'CAD готовится'}, {state.photosReady ? 'фото есть' : 'нет фото'}, {state.unseenCount ? `не просмотрено: ${state.unseenCount}` : 'всё просмотрено'}.
          </p>
        ) : null}

        <div className="divider" style={{ margin: '14px 0' }} />
        <div className="folder-group">
          <h4 className="folder-group__title">Ручные схемы и CAD</h4>
          {state.schemes.length === 0 ? (
            <p className="field__hint">Схем по этому дому нет.</p>
          ) : (
            state.schemes.map(report => (
              <div key={report.id} className="review-card">
                <div className="review-card__head">
                  <span className="review-card__message">{report.userName} · {formatDateTime(report.submittedAt)}</span>
                  <Badge tone={statusTone(report.status)}>{reviewStatusLabel(report.status)}</Badge>
                </div>
                {report.note ? <span className="field__hint">{report.note}</span> : null}
                {report.sketch ? (
                  <div className="attach-grid">
                    <a className="attach" href={report.sketch.url} target="_blank" rel="noopener">
                      <img src={report.sketch.url} alt={report.sketch.originalName} />
                      <span className="attach__name">{report.sketch.originalName}</span>
                    </a>
                  </div>
                ) : null}
                <div className="review-card__actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || busyLocal || report.status === 'accepted'}
                    onClick={() => void workforceApi.reviewReport(report.id, 'accepted', '').then(() => onRefresh('Схема принята')).catch(cause => notify(cause instanceof Error ? cause.message : 'Ошибка', 'error'))}
                  >
                    Принять
                  </Button>
                  <Button size="sm" disabled={busy || busyLocal} onClick={() => { setReviewId(report.id); setKind('scheme'); setComment(''); }}>Вернуть</Button>
                  {report.manualCadProjectId ? (
                    <Link className="btn btn--sm" to={`/cad/${report.manualCadProjectId}`}>Открыть CAD</Link>
                  ) : (
                    <Badge tone="warn">{report.schemeStatus || 'CAD готовится'}</Badge>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="folder-group" style={{ marginTop: 16 }}>
          <h4 className="folder-group__title">Фотографии дефектов</h4>
          {state.defects.length === 0 ? (
            <p className="field__hint">Фотографий дефектов нет.</p>
          ) : (
            state.defects.map(report => (
              <div key={report.id} className="review-card">
                <div className="review-card__head">
                  <span className="review-card__message">{report.userName} · {formatDateTime(report.submittedAt)}</span>
                  <Badge tone={statusTone(report.status)}>{reviewStatusLabel(report.status)}</Badge>
                </div>
                {report.note ? <span className="field__hint">{report.note}</span> : null}
                <div className="attach-grid">
                  {report.photos.map(photo => (
                    <a key={photo.id} className="attach" href={photo.url} target="_blank" rel="noopener">
                      <img src={photo.url} alt={photo.originalName} />
                      <span className="attach__name">{photo.originalName}</span>
                    </a>
                  ))}
                </div>
                <div className="review-card__actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || busyLocal || report.status === 'accepted'}
                    onClick={() => void workforceApi.reviewDefect(report.id, 'accepted', '').then(() => onRefresh('Комплект фотографий принят')).catch(cause => notify(cause instanceof Error ? cause.message : 'Ошибка', 'error'))}
                  >
                    Подтвердить фото
                  </Button>
                  <Button size="sm" disabled={busy || busyLocal} onClick={() => { setReviewId(report.id); setKind('defect'); setComment(''); }}>Вернуть</Button>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      {reviewId ? (
        <Modal
          title={kind === 'scheme' ? 'Вернуть схему' : 'Вернуть фотографии'}
          onClose={() => setReviewId(null)}
          footer={
            <>
              <Button onClick={() => setReviewId(null)}>Отмена</Button>
              <Button variant="danger" disabled={busyLocal} onClick={() => void review('revision_requested')}>Вернуть слесарю</Button>
            </>
          }
        >
          <Field label="Комментарий">
            <textarea className="textarea" value={comment} onChange={event => setComment(event.target.value)} placeholder="Что нужно переделать или уточнить…" />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}

function ScheduleTab({
  tasks,
  users,
  onCreated,
  onError,
}: {
  tasks: WorkforceTask[];
  users: WorkforceUser[];
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="stack">
      <div className="grid grid--sidebar" style={{ alignItems: 'start' }}>
        <Card title="Как назначить">
          <p className="field__hint">
            Выберите слесаря, улицу и перечислите дома. Система создаст отдельное задание для каждого адреса,
            чтобы папки приёмки не смешивались.
          </p>
          <div className="alert alert--info" style={{ marginTop: 12 }}>
            <Icon name="info" />
            <span>Слесарь увидит задания сразу после входа и сможет отмечать этапы обхода.</span>
          </div>
        </Card>
        <TaskForm users={users} onCreated={onCreated} onError={onError} />
      </div>
      <Card title={`Задания · ${tasks.length}`} flush>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Адрес</th><th>Слесарь</th><th>Дата</th><th>Статус</th><th>Материалы</th></tr></thead>
            <tbody>
              {tasks.map(task => (
                <tr key={task.id}>
                  <td>{task.street}, {task.address}</td>
                  <td>{task.assignedName}</td>
                  <td className="nowrap">{formatShortDate(task.scheduledDate)}</td>
                  <td><Badge tone={statusTone(task.status)}>{taskStatusLabel(task.status)}</Badge></td>
                  <td className="muted">{task.reportsCount} схем · {task.defectReportsCount} дефектов</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function TaskForm({
  users,
  onCreated,
  onError,
}: {
  users: WorkforceUser[];
  onCreated: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [assignedTo, setAssignedTo] = useState(users[0]?.id || '');
  const [title, setTitle] = useState('');
  const [street, setStreet] = useState('');
  const [addresses, setAddresses] = useState('');
  const [date, setDate] = useState(isoDate());
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await workforceApi.createTask({ assignedTo, title, street, addresses, scheduledDate: date, instructions });
      onCreated(`Создано заданий: ${result.createdCount}`);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Не удалось создать задание');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Параметры задания">
      <form className="stack stack--sm" onSubmit={submit}>
        <Field label="Слесарь" required>
          <select className="select" value={assignedTo} onChange={event => setAssignedTo(event.target.value)} required>
            {users.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </Field>
        <Field label="Название" required>
          <input className="input" value={title} onChange={event => setTitle(event.target.value)} required placeholder="Обход ВДГО" />
        </Field>
        <Field label="Улица" required>
          <input className="input" value={street} onChange={event => setStreet(event.target.value)} required />
        </Field>
        <Field label="Адреса" required hint="По одному дому в строке.">
          <textarea className="textarea" value={addresses} onChange={event => setAddresses(event.target.value)} required placeholder={"1\n2\n4"} />
        </Field>
        <Field label="Дата" required>
          <input className="input" type="date" value={date} onChange={event => setDate(event.target.value)} required />
        </Field>
        <Field label="Указания">
          <textarea className="textarea" value={instructions} onChange={event => setInstructions(event.target.value)} />
        </Field>
        <Button type="submit" variant="primary" icon="plus" disabled={busy}>{busy ? <Spinner light /> : null} Назначить</Button>
      </form>
    </Card>
  );
}

function TaskFormModal({
  users,
  onClose,
  onCreated,
  onError,
}: {
  users: WorkforceUser[];
  onClose: () => void;
  onCreated: (message: string) => void;
  onError: (message: string) => void;
}) {
  return (
    <Modal title="Назначить задание" onClose={onClose} footer={<Button onClick={onClose}>Закрыть</Button>}>
      {users.length === 0 ? (
        <div className="alert alert--warn"><Icon name="alert" /><span>Сначала создайте аккаунт слесаря во вкладке «Пользователи».</span></div>
      ) : (
        <TaskForm users={users} onCreated={onCreated} onError={onError} />
      )}
    </Modal>
  );
}

function OverviewTab({
  overview,
  tasks,
  reports,
  defects,
}: {
  overview: WorkforceOverview | null;
  tasks: WorkforceTask[];
  reports: WorkforceReport[];
  defects: WorkforceDefectReport[];
}) {
  const summary = overview?.summary;
  const pendingReports = reports.filter(report => report.status === 'pending_review').length;
  const pendingDefects = defects.filter(report => report.status === 'pending_review').length;

  return (
    <div className="stack">
      <div className="grid grid--4">
        <div className="stat">
          <span className="stat__label"><span className="stat__icon"><Icon name="users" /></span> Активные слесари</span>
          <span className="stat__value">{summary?.activeFitters ?? overview?.users.filter(item => item.role === 'fitter' && item.active).length ?? 0}</span>
        </div>
        <div className="stat">
          <span className="stat__label"><span className="stat__icon"><Icon name="team" /></span> Активные задания</span>
          <span className="stat__value">{summary?.assigned ?? tasks.filter(task => ACTIVE_STATUSES.includes(task.status)).length}</span>
        </div>
        <div className="stat">
          <span className="stat__label"><span className="stat__icon"><Icon name="scheme" /></span> Отправлено схем</span>
          <span className="stat__value">{summary?.submitted ?? reports.length}</span>
        </div>
        <div className="stat">
          <span className="stat__label"><span className="stat__icon"><Icon name="clock" /></span> Ждут проверки</span>
          <span className="stat__value">{summary?.pendingReports ?? pendingReports} + {summary?.pendingDefects ?? pendingDefects}</span>
          <span className="stat__hint">схем + комплектов дефектов</span>
        </div>
      </div>
      <Card title="Отметки слесарей" flush>
        {tasks.length === 0 ? (
          <Empty icon="team" title="Заданий нет">Назначьте задания, чтобы видеть этапы работ.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Адрес</th><th>Слесарь</th><th>Статус</th><th>Материалы</th><th>Обновлено</th></tr></thead>
              <tbody>
                {tasks.map(task => (
                  <tr key={task.id}>
                    <td>{task.street}, {task.address}</td>
                    <td>{task.assignedName}</td>
                    <td><Badge tone={statusTone(task.status)}>{taskStatusLabel(task.status)}</Badge></td>
                    <td className="muted">{task.reportsCount} схем · {task.defectReportsCount} дефектов</td>
                    <td className="nowrap muted">{formatDateTime(task.events.at(-1)?.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function UsersTab({
  users,
  canManage,
  onRefresh,
  onCreate,
}: {
  users: WorkforceUser[];
  canManage: boolean;
  onRefresh: (message?: string) => Promise<void>;
  onCreate: () => void;
}) {
  const { notify } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggle = async (item: WorkforceUser) => {
    setBusyId(item.id);
    try {
      await workforceApi.updateUser(item.id, { active: !item.active });
      await onRefresh(item.active ? 'Аккаунт отключён' : 'Аккаунт включён');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось изменить аккаунт', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card
      title={`Пользователи · ${users.length}`}
      actions={canManage ? <Button size="sm" variant="primary" icon="plus" onClick={onCreate}>Создать аккаунт</Button> : null}
      flush
    >
      {users.length === 0 ? (
        <Empty icon="users" title="Пользователей нет">Создайте аккаунты слесарей и приёмщиков.</Empty>
      ) : (
        <div className="card__body stack stack--sm">
          {users.map(item => (
            <div key={item.id} className="user-card">
              <span className="sidebar__avatar">{item.displayName.slice(0, 1)}</span>
              <div className="user-card__main">
                <span className="user-card__name">{item.displayName} · {item.username}</span>
                <span className="user-card__meta">{roleLabel(item.role)} · {item.active ? 'активен' : 'отключён'} · заданий: {item.assignedTasks ?? 0}</span>
              </div>
              <Badge tone={item.active ? 'success' : 'default'}>{item.active ? 'Активен' : 'Отключён'}</Badge>
              {canManage && item.role !== 'developer' ? (
                <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void toggle(item)}>
                  {item.active ? 'Отключить' : 'Включить'}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function CredentialsTab({ users, onReset }: { users: WorkforceUser[]; onReset: (id: string) => void }) {
  return (
    <Card title="Учётные записи" flush>
      {users.length === 0 ? (
        <Empty icon="users" title="Аккаунтов нет">Создайте первый аккаунт во вкладке «Пользователи».</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Сотрудник</th><th>Логин</th><th>Роль</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {users.filter(item => item.role !== 'developer').map(item => (
                <tr key={item.id}>
                  <td>{item.displayName}</td>
                  <td className="mono">{item.username}</td>
                  <td>{roleLabel(item.role)}</td>
                  <td><Badge tone={item.active ? 'success' : 'default'}>{item.active ? 'Активен' : 'Отключён'}</Badge></td>
                  <td style={{ textAlign: 'right' }}>
                    <Button size="sm" disabled={!item.active} onClick={() => onReset(item.id)}>Выдать пароль</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function UserFormModal({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: (result: { credentials: { username: string; password: string } }) => void;
  onError: (message: string) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('fitter');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await workforceApi.createUser({ displayName, role, autoGenerate: true });
      onCreated(result);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Не удалось создать аккаунт');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Создать аккаунт"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={busy || !displayName} onClick={submit}>Создать</Button>
        </>
      }
    >
      <Field label="Имя и фамилия" required>
        <input className="input" value={displayName} onChange={event => setDisplayName(event.target.value)} required autoFocus />
      </Field>
      <Field label="Роль" required>
        <select className="select" value={role} onChange={event => setRole(event.target.value)}>
          <option value="fitter">Слесарь</option>
          <option value="receiver">Приёмщик</option>
          <option value="supervisor">Руководитель</option>
        </select>
      </Field>
      <p className="field__hint">Логин и временный пароль система сгенерирует автоматически.</p>
    </Modal>
  );
}

export type { SessionUser };