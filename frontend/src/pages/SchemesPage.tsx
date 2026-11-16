import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import { Badge, Button, Card, Empty, Field, Loading, Spinner, useToast } from '../components/ui';
import { libraryApi } from '../lib/api';
import { formatDateTime, schemeStatusLabel } from '../lib/format';
import type { AddressLibrary, Building, SchemeSummary, Street } from '../lib/types';

function statusTone(status: string): 'success' | 'warn' | 'danger' | 'info' | 'default' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'processing' || status === 'queued') return 'info';
  return 'warn';
}

export function SchemesPage() {
  const [params, setParams] = useSearchParams();
  const { notify } = useToast();
  const [library, setLibrary] = useState<AddressLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(params.get('q') || '');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<'street' | 'building' | null>(null);
  const [newName, setNewName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [rotation, setRotation] = useState('auto');
  const [refreshTick, setRefreshTick] = useState(0);

  const selectedStreetId = params.get('street');
  const selectedBuildingId = params.get('building');
  const selectedJobId = params.get('job');

  const load = useCallback(async () => {
    try {
      const data = await libraryApi.list();
      setLibrary(data.library);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить папки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  const filteredStreets = useMemo(() => {
    if (!library) return [];
    const needle = query.trim().toLocaleLowerCase('ru');
    if (!needle) return library.streets;
    return library.streets.filter(street =>
      street.name.toLocaleLowerCase('ru').includes(needle) ||
      street.buildings.some(building => building.name.toLocaleLowerCase('ru').includes(needle)),
    );
  }, [library, query]);

  const selectedBuilding: { street: Street; building: Building } | null = useMemo(() => {
    if (!library || !selectedStreetId || !selectedBuildingId) return null;
    const street = library.streets.find(item => item.id === selectedStreetId);
    const building = street?.buildings.find(item => item.id === selectedBuildingId);
    return street && building ? { street, building } : null;
  }, [library, selectedStreetId, selectedBuildingId]);

  const schemes = selectedBuilding?.building.schemes || [];
  const busySchemes = schemes.filter(scheme => ['pending', 'queued', 'processing'].includes(scheme.status));

  useEffect(() => {
    if (!busySchemes.length) return;
    const timer = window.setInterval(() => setRefreshTick(tick => tick + 1), 5000);
    return () => window.clearInterval(timer);
  }, [busySchemes.length]);

  const openBuilding = (street: Street, building: Building) => {
    setParams({ street: street.id, building: building.id });
    setExpanded(current => new Set(current).add(street.id));
  };

  const selectStreet = (streetId: string) => {
    setParams(selectedStreetId === streetId ? {} : { street: streetId });
  };

  const createStreet = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await libraryApi.createStreet(newName);
      setCreating(null);
      setNewName('');
      notify('Улица добавлена', 'success');
      await load();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось создать улицу', 'error');
    }
  };

  const createBuilding = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedStreetId) return;
    try {
      await libraryApi.createBuilding(selectedStreetId, newName);
      setCreating(null);
      setNewName('');
      notify('Дом добавлен', 'success');
      await load();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось создать дом', 'error');
    }
  };

  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!uploadFile || !selectedStreetId || !selectedBuildingId) {
      notify('Выберите файл, улицу и дом', 'error');
      return;
    }
    setUploading(true);
    try {
      const result = await libraryApi.uploadScheme({
        file: uploadFile,
        streetId: selectedStreetId,
        buildingId: selectedBuildingId,
        title: uploadTitle || undefined,
        rotationDegrees: rotation,
      });
      setUploadFile(null);
      setUploadTitle('');
      setRotation('auto');
      notify('Эскиз отправлен на распознавание', 'success');
      setParams({ street: selectedStreetId, building: selectedBuildingId, job: result.scheme.jobId });
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось загрузить эскиз', 'error');
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <Card><Loading>Загружаем папки объектов…</Loading></Card>;

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

  return (
    <>
      <header className="page__header">
        <div>
          <p className="page__eyebrow">Распознавание</p>
          <h1>Схемы домов</h1>
          <p className="page__subtitle">
            Загружайте эскизы слесарей, запускайте локальное распознавание и проверяйте полученные CAD-схемы.
          </p>
        </div>
        <div className="page__actions">
          <Button icon="refresh" onClick={() => setRefreshTick(tick => tick + 1)}>Обновить</Button>
          <Button variant="primary" icon="plus" onClick={() => { setCreating('street'); setNewName(''); }}>Добавить улицу</Button>
        </div>
      </header>

      <div className="workspace-grid">
        <aside className="workspace-side">
          <Card title="Папки объектов" actions={selectedStreetId ? <Button size="sm" variant="ghost" icon="plus" onClick={() => { setCreating('building'); setNewName(''); }}>Дом</Button> : null} flush>
            <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
              <div className="searchbox" style={{ width: '100%' }}>
                <Icon name="search" />
                <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Улица или дом…" aria-label="Поиск по папкам" />
              </div>
            </div>
            <div className="card__body" style={{ padding: 8 }}>
              {filteredStreets.length === 0 ? (
                <Empty icon="folder" title="Папок нет">Создайте улицу, чтобы загружать эскизы.</Empty>
              ) : (
                <div className="tree">
                  {filteredStreets.map(street => {
                    const isOpen = expanded.has(street.id) || Boolean(selectedStreetId === street.id) || Boolean(query);
                    return (
                      <div key={street.id}>
                        <button type="button" className="tree__row" onClick={() => selectStreet(street.id)}>
                          <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} />
                          <Icon name="building" />
                          <span className="text-truncate">{street.name}</span>
                          <span className="tree__count">{street.buildings.length}</span>
                        </button>
                        {isOpen ? (
                          <div className="tree__children">
                            {street.buildings.map(building => {
                              const active = selectedBuildingId === building.id;
                              return (
                                <button
                                  key={building.id}
                                  type="button"
                                  className={`tree__row ${active ? 'tree__row--active' : ''}`}
                                  onClick={() => openBuilding(street, building)}
                                >
                                  <Icon name="home" />
                                  <span className="text-truncate">дом {building.name}</span>
                                  <span className="tree__count">{building.schemes.length}</span>
                                </button>
                              );
                            })}
                            {street.buildings.length === 0 ? <p className="field__hint" style={{ padding: '4px 8px' }}>Домов пока нет</p> : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>

          {creating ? (
            <Card title={creating === 'street' ? 'Новая улица' : 'Новый дом'}>
              <form className="stack stack--sm" onSubmit={creating === 'street' ? createStreet : createBuilding}>
                <Field label={creating === 'street' ? 'Название улицы' : 'Номер дома'} required>
                  <input className="input" value={newName} onChange={event => setNewName(event.target.value)} required autoFocus />
                </Field>
                {creating === 'building' && selectedStreetId ? (
                  <p className="field__hint">Улица: {library?.streets.find(item => item.id === selectedStreetId)?.name}</p>
                ) : null}
                <div className="row">
                  <Button type="submit" variant="primary" size="sm">Создать</Button>
                  <Button size="sm" variant="ghost" onClick={() => setCreating(null)}>Отмена</Button>
                </div>
              </form>
            </Card>
          ) : null}
        </aside>

        <section className="workspace-canvas">
          {!selectedBuilding ? (
            <Card>
              <Empty icon="building" title="Выберите дом">Слева выберите улицу и дом, чтобы увидеть загруженные схемы.</Empty>
            </Card>
          ) : (
            <>
              <Card
                title={
                  <>
                    <Icon name="upload" />
                    Загрузить эскиз
                  </>
                }
                actions={<Badge tone="brand" plain>{selectedBuilding.street.name}, дом {selectedBuilding.building.name}</Badge>}
              >
                <form className="stack" onSubmit={upload}>
                  <div className="field-row">
                    <Field label="Файл эскиза" required>
                      <input
                        className="input"
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/tiff"
                        onChange={event => setUploadFile(event.target.files?.[0] || null)}
                        required
                      />
                    </Field>
                    <Field label="Название схемы">
                      <input className="input" value={uploadTitle} onChange={event => setUploadTitle(event.target.value)} placeholder="Например, подъезд 1, ввод" />
                    </Field>
                  </div>
                  <div className="field-row">
                    <Field label="Поворот" hint="Оставьте «Авто», если эскиз уже правильно ориентирован.">
                      <select className="select" value={rotation} onChange={event => setRotation(event.target.value)}>
                        <option value="auto">Автоматически</option>
                        <option value="0">Без поворота</option>
                        <option value="90">90°</option>
                        <option value="180">180°</option>
                        <option value="270">270°</option>
                      </select>
                    </Field>
                    <div className="row" style={{ alignItems: 'flex-end' }}>
                      <Button type="submit" variant="primary" icon="upload" disabled={uploading || !uploadFile}>
                        {uploading ? <Spinner light /> : null}
                        Отправить на распознавание
                      </Button>
                    </div>
                  </div>
                </form>
              </Card>

              <Card
                title={`Схемы дома · ${schemes.length}`}
                actions={<Button size="sm" variant="ghost" icon="refresh" onClick={() => setRefreshTick(tick => tick + 1)}>Обновить</Button>}
                flush
              >
                {schemes.length === 0 ? (
                  <Empty icon="scheme" title="Схем пока нет">Загрузите первый эскиз — распознавание запустится автоматически.</Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr><th>Схема</th><th>Статус</th><th>Загрузил</th><th>Обновлено</th><th /></tr>
                      </thead>
                      <tbody>
                        {schemes.map(scheme => (
                          <tr key={scheme.jobId} style={selectedJobId === scheme.jobId ? { background: 'var(--brand-soft)' } : undefined}>
                            <td>
                              <Link to={`/schemes?street=${selectedBuilding.street.id}&building=${selectedBuilding.building.id}&job=${scheme.jobId}`}>
                                {scheme.title || scheme.originalName}
                              </Link>
                              <div className="muted" style={{ fontSize: 11 }}>{scheme.error || `Файл: ${scheme.sourceName}`}</div>
                            </td>
                            <td><Badge tone={statusTone(scheme.status)}>{schemeStatusLabel(scheme.status)}</Badge></td>
                            <td className="nowrap">{scheme.uploadedBy || '—'}</td>
                            <td className="nowrap muted">{formatDateTime(scheme.updatedAt || scheme.createdAt)}</td>
                            <td style={{ textAlign: 'right' }}>
                              <Link className="btn btn--sm" to={`/schemes/${encodeURIComponent(scheme.jobId)}`}>Открыть</Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </section>
      </div>
    </>
  );
}

export type { SchemeSummary };