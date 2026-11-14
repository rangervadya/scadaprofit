import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import { Badge, Button, Card, Empty, Field, Loading, Modal, Spinner, useToast } from '../components/ui';
import { cadApi } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ManualCadProjectSummary } from '../lib/types';

export function CadPage() {
  const navigate = useNavigate();
  const { notify } = useToast();
  const [projects, setProjects] = useState<ManualCadProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await cadApi.list();
      setProjects(Array.isArray(data.projects) ? data.projects : []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить проекты');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await cadApi.create(title || 'Новая схема');
      setCreating(false);
      setTitle('');
      notify('Чертёж создан', 'success');
      navigate(`/cad/${result.project.id}`);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось создать чертёж', 'error');
    } finally {
      setBusy(false);
    }
  };

  const filtered = projects.filter(project => {
    const needle = query.trim().toLocaleLowerCase('ru');
    if (!needle) return true;
    return `${project.title} ${project.siteAddress}`.toLocaleLowerCase('ru').includes(needle);
  });

  return (
    <>
      <header className="page__header">
        <div>
          <p className="page__eyebrow">Чертежи</p>
          <h1>CAD-редактор</h1>
          <p className="page__subtitle">Рисуйте схемы вручную или дорабатывайте импортированные из распознавания.</p>
        </div>
        <div className="page__actions">
          <Button icon="refresh" onClick={() => void load()} disabled={loading}>Обновить</Button>
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Новый чертёж</Button>
        </div>
      </header>

      <div className="row row--wrap">
        <div className="searchbox" style={{ width: 'min(360px, 100%)' }}>
          <Icon name="search" />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск по чертежам…" aria-label="Поиск по чертежам" />
        </div>
        <span className="grow" />
        <Badge plain>Всего: {projects.length}</Badge>
      </div>

      {loading ? <Card><Loading>Загружаем чертежи…</Loading></Card> : null}

      {error ? (
        <div className="alert alert--danger"><Icon name="alert" /><div><div style={{ fontWeight: 650 }}>{error}</div><div className="row" style={{ marginTop: 8 }}><Button size="sm" onClick={() => void load()}>Повторить</Button></div></div></div>
      ) : null}

      {!loading && !error ? (
        filtered.length === 0 ? (
          <Card>
            <Empty icon="cad" title="Чертежей нет" action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Создать чертёж</Button>}>
              Начните с нового чертежа или откройте CAD из импортированной схемы.
            </Empty>
          </Card>
        ) : (
          <div className="grid grid--3">
            {filtered.map(project => (
              <Link key={project.id} to={`/cad/${project.id}`} className="quick-card">
                <span className="quick-card__icon"><Icon name="cad" /></span>
                <span className="quick-card__title">{project.title}</span>
                <span className="quick-card__text">{project.siteAddress || 'Адрес не указан'}</span>
                <span className="row row--wrap" style={{ marginTop: 4 }}>
                  <Badge plain>{project.pipeCount} труб</Badge>
                  <Badge plain>{project.source ? 'с подложкой' : 'без подложки'}</Badge>
                </span>
                <span className="field__hint">Изменён {formatDateTime(project.updatedAt)}</span>
              </Link>
            ))}
          </div>
        )
      ) : null}

      {creating ? (
        <Modal
          title="Новый чертёж"
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button onClick={() => setCreating(false)}>Отмена</Button>
              <Button variant="primary" disabled={busy} onClick={create}>Создать</Button>
            </>
          }
        >
          <Field label="Название" required>
            <input className="input" value={title} onChange={event => setTitle(event.target.value)} autoFocus placeholder="Например, дом 5, подъезд 1" />
          </Field>
          <p className="field__hint">Чертёж создаётся пустым. Подложку можно загрузить внутри редактора.</p>
        </Modal>
      ) : null}

      {busy ? <span className="loading"><Spinner /> Создаём чертёж…</span> : null}
    </>
  );
}