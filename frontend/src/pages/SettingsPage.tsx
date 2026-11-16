import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import { Badge, Button, Card, Field, Loading, Modal, Spinner, useToast } from '../components/ui';
import { healthApi, templateApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useHealth } from '../lib/health';
import { formatDateTime } from '../lib/format';
import type { HealthResponse } from '../lib/types';

type TemplateInfo = { originalName: string; size: number; uploadedAt: string; downloadUrl?: string } | null;

export function SettingsPage() {
  const { user, logout } = useAuth();
  const health = useHealth();
  const { notify } = useToast();
  const [template, setTemplate] = useState<TemplateInfo>(null);
  const [loadingTemplate, setLoadingTemplate] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [vdgoHealth, setVdgoHealth] = useState<HealthResponse | null>(null);
  const [vdgoError, setVdgoError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const loadTemplate = useCallback(async () => {
    setLoadingTemplate(true);
    try {
      const data = await templateApi.get();
      setTemplate(data.template);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось загрузить шаблон', 'error');
    } finally {
      setLoadingTemplate(false);
    }
  }, [notify]);

  const checkVdgo = useCallback(async () => {
    setChecking(true);
    try {
      const data = await healthApi.vdgo();
      setVdgoHealth(data);
      setVdgoError(null);
    } catch (cause) {
      setVdgoHealth(null);
      setVdgoError(cause instanceof Error ? cause.message : 'Сервис недоступен');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplate();
    void checkVdgo();
  }, [loadTemplate, checkVdgo]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      await templateApi.upload(file);
      notify('Эталонный шаблон обновлён', 'success');
      await loadTemplate();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось загрузить шаблон', 'error');
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    try {
      await templateApi.remove();
      setConfirmRemove(false);
      notify('Эталонный шаблон удалён', 'success');
      await loadTemplate();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось удалить шаблон', 'error');
    }
  };

  const isDeveloper = user?.role === 'developer';

  return (
    <>
      <header className="page__header">
        <div>
          <p className="page__eyebrow">Система</p>
          <h1>Настройки</h1>
          <p className="page__subtitle">Эталонный шаблон заключения, состояние сервисов и параметры доступа.</p>
        </div>
        <div className="page__actions">
          <Button icon="refresh" onClick={() => { void loadTemplate(); void checkVdgo(); health.reload(); }}>Обновить всё</Button>
        </div>
      </header>

      <div className="settings-grid">
        <Card
          title={<><Icon name="doc" /> Эталонный шаблон</>}
          actions={template ? <Badge tone="success">Загружен</Badge> : <Badge tone="warn">Не загружен</Badge>}
        >
          {loadingTemplate ? (
            <Loading>Проверяем шаблон…</Loading>
          ) : template ? (
            <div className="stack stack--sm">
              <dl className="kv">
                <dt>Файл</dt><dd className="text-truncate">{template.originalName}</dd>
                <dt>Размер</dt><dd>{(template.size / 1024 / 1024).toFixed(2)} МБ</dd>
                <dt>Загружен</dt><dd>{formatDateTime(template.uploadedAt)}</dd>
              </dl>
              <div className="row row--wrap">
                <a className="btn btn--sm" href={template.downloadUrl || '/api/template/file'}><Icon name="download" /> Скачать</a>
                {isDeveloper ? <Button size="sm" variant="danger" icon="trash" onClick={() => setConfirmRemove(true)}>Удалить</Button> : null}
              </div>
            </div>
          ) : (
            <div className="stack stack--sm">
              <div className="alert alert--warn"><Icon name="alert" /><span>Эталонный PDF не загружен — заключение сформировать не получится.</span></div>
              <p className="field__hint">Загрузите PDF-шаблон технического заключения ВДГО (многостраничный документ).</p>
            </div>
          )}

          {isDeveloper ? (
            <div style={{ marginTop: 14 }}>
              <Field label="Загрузить новый шаблон" hint="PDF или SVG. Загрузка заменяет текущий эталон.">
                <input
                  className="input"
                  type="file"
                  accept="application/pdf,.pdf,image/svg+xml,.svg"
                  disabled={uploading}
                  onChange={event => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file);
                    event.target.value = '';
                  }}
                />
              </Field>
              {uploading ? <p className="row field__hint" style={{ marginTop: 8 }}><Spinner /> Загружаем шаблон…</p> : null}
            </div>
          ) : (
            <p className="field__hint" style={{ marginTop: 12 }}>Изменять шаблон может только разработчик.</p>
          )}
        </Card>

        <Card title={<><Icon name="server" /> Состояние сервисов</>}>
          {health.loading && checking ? (
            <Loading>Проверяем сервисы…</Loading>
          ) : (
            <div className="status-list">
              <div className="status-row">
                <span className="status-row__key">Основной сервис</span>
                {health.error ? <Badge tone="danger">Недоступен</Badge> : <Badge tone="success">Доступен</Badge>}
              </div>
              <div className="status-row"><span className="status-row__key">Версия</span><span>{health.data?.version || '—'}</span></div>
              <div className="status-row"><span className="status-row__key">Режим</span><span>{health.data?.mode || '—'}</span></div>
              <div className="status-row"><span className="status-row__key">Распознавание</span><span>{health.data?.localRecognition?.mode || '—'}</span></div>
              <div className="status-row"><span className="status-row__key">Модель Qwen</span><span className="mono">{health.data?.qwenModel || '—'}</span></div>
              <div className="status-row"><span className="status-row__key">Ollama</span>{health.data?.ollama?.reachable ? <Badge tone="success">Отвечает</Badge> : <Badge tone="warn">Нет</Badge>}</div>
              <div className="status-row"><span className="status-row__key">Tesseract</span>{health.data?.localRecognition?.mode ? <Badge tone="success">Настроен</Badge> : <Badge tone="warn">—</Badge>}</div>
              <div className="divider" />
              <div className="status-row">
                <span className="status-row__key">Сервис заключений</span>
                {checking ? <Spinner /> : vdgoError ? <Badge tone="danger">{vdgoError}</Badge> : <Badge tone="success">Доступен</Badge>}
              </div>
              {vdgoHealth ? <div className="status-row"><span className="status-row__key">Версия сервиса</span><span className="mono">{vdgoHealth.version || '—'}</span></div> : null}
            </div>
          )}
          {health.error ? <div className="alert alert--danger" style={{ marginTop: 12 }}><Icon name="alert" /><span>{health.error}</span></div> : null}
          {health.data?.ollama?.error ? <div className="alert alert--warn" style={{ marginTop: 12 }}><Icon name="alert" /><span>{health.data.ollama.error}</span></div> : null}
        </Card>

        <Card title={<><Icon name="users" /> Аккаунт</>}>
          {user ? (
            <div className="stack stack--sm">
              <dl className="kv">
                <dt>Имя</dt><dd>{user.displayName}</dd>
                <dt>Логин</dt><dd className="mono">{user.username}</dd>
                <dt>Роль</dt><dd>{user.roleName}</dd>
              </dl>
              <div className="row">
                <Link className="btn btn--sm" to="/team"><Icon name="users" /> Управление командой</Link>
                <Button size="sm" variant="danger" icon="logout" onClick={() => void logout()}>Выйти</Button>
              </div>
            </div>
          ) : (
            <div className="stack stack--sm">
              <p className="field__hint">Сессия не найдена.</p>
              <Link className="btn btn--sm btn--primary" to="/login">Войти</Link>
            </div>
          )}
        </Card>

        <Card title="Диагностика">
          <div className="stack stack--sm">
            <Button size="sm" icon="refresh" onClick={() => { health.reload(); void checkVdgo(); void loadTemplate(); }}>Проверить контур</Button>
            <div className="alert alert--info">
              <Icon name="info" />
              <span>Проверка доступна без входа, но данные показываются только авторизованным пользователям.</span>
            </div>
            <p className="field__hint">
              Распознавание работает локально: Ollama Qwen3-VL и Tesseract. Облачные провайдеры отключены в контуре.
            </p>
          </div>
        </Card>
      </div>

      {confirmRemove ? (
        <Modal
          title="Удалить эталонный шаблон?"
          onClose={() => setConfirmRemove(false)}
          footer={
            <>
              <Button onClick={() => setConfirmRemove(false)}>Отмена</Button>
              <Button variant="danger" icon="trash" onClick={() => void remove()}>Удалить</Button>
            </>
          }
        >
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
            После удаления шаблона формирование заключений станет недоступным до загрузки нового файла.
          </p>
        </Modal>
      ) : null}
    </>
  );
}