import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import { Badge, Button, Card, Empty, Field, Loading, Modal, Spinner, useToast } from '../components/ui';
import { GraphView } from '../components/GraphView';
import { cadApi, libraryApi } from '../lib/api';
import type { JobGraph, ReviewTask } from '../lib/types';

type Tab = 'graph' | 'nodes' | 'edges' | 'review' | 'cad';

const REVIEW_LABELS: Record<string, string> = {
  verify_text: 'Подтвердить подпись',
  assign_dimension: 'Назначить размер',
  classify_symbol: 'Классифицировать символ',
  dismiss_task: 'Скрыть замечание',
};

export function SchemeDetailPage() {
  const { jobId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { notify } = useToast();
  const [graph, setGraph] = useState<JobGraph | null>(null);
  const [meta, setMeta] = useState<{ street: string; address: string; title: string; status: string; progress?: string; error?: string; graphReady?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('graph');
  const [visibleEdges, setVisibleEdges] = useState<Set<string>>(new Set());
  const [showNodes, setShowNodes] = useState(true);
  const [showCrossings, setShowCrossings] = useState(true);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<ReviewTask | null>(null);
  const [taskValue, setTaskValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const scheme = await libraryApi.schemeStatus(jobId);
      setMeta(current => ({
        street: current?.street || '',
        address: current?.address || '',
        title: current?.title || jobId,
        status: scheme.status,
        progress: scheme.progress,
        error: scheme.error,
        graphReady: scheme.graphReady,
      }));
      if (scheme.graphReady) {
        const next = await libraryApi.graph(jobId);
        setGraph(next);
        setVisibleEdges(new Set(next.edges.map(edge => edge.id)));
      } else {
        setGraph(null);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить схему');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  useEffect(() => {
    if (graph?.complete) return;
    const timer = window.setInterval(() => setRefreshTick(tick => tick + 1), 6000);
    return () => window.clearInterval(timer);
  }, [graph?.complete]);

  const tasks = graph?.documentModel?.reviewTasks || [];
  const findings = graph?.documentModel?.validationFindings || [];
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];

  const runReview = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await libraryApi.review(jobId, payload as Parameters<typeof libraryApi.review>[1]);
      setGraph(result.graph);
      setSelectedTask(null);
      setTaskValue('');
      notify('Изменение сохранено', 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось сохранить изменение', 'error');
    } finally {
      setBusy(false);
    }
  };

  const importCad = async () => {
    if (!meta) return;
    setBusy(true);
    try {
      const result = await libraryApi.schemeStatus(jobId);
      if (!result.graphReady) throw new Error('Схема ещё не готова для импорта в CAD.');
      const title = meta.title || `${meta.street}, дом ${meta.address}`;
      const project = await cadApi.importJob(jobId, title);
      notify('CAD-проект создан', 'success');
      setParams({ open: project.project.id });
      window.location.assign(`/vdgo/cad/${project.project.id}`);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось создать CAD-проект', 'error');
    } finally {
      setBusy(false);
    }
  };

  const openTask = (task: ReviewTask) => {
    setSelectedTask(task);
    setTaskValue(task.kind === 'verify_text' ? '' : task.kind === 'assign_dimension' ? '' : 'valve');
  };

  const submitTask = async () => {
    if (!selectedTask) return;
    if (selectedTask.kind === 'verify_text') {
      await runReview({ action: 'verify_text', targetId: selectedTask.targetIds?.[0] || '', text: taskValue });
      return;
    }
    if (selectedTask.kind === 'assign_dimension') {
      await runReview({ action: 'assign_dimension', targetId: selectedTask.targetIds?.[0] || '', value: taskValue });
      return;
    }
    await runReview({ action: 'classify_symbol', targetId: selectedTask.targetIds?.[0] || '', symbolType: taskValue });
  };

  const selectedTaskLabel = selectedTask ? REVIEW_LABELS[selectedTask.kind || ''] || 'Действие' : '';

  if (loading && !graph) return <Card><Loading>Загружаем схему…</Loading></Card>;
  if (error) {
    return (
      <div className="alert alert--danger">
        <Icon name="alert" />
        <div>
          <div style={{ fontWeight: 650 }}>{error}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => { setLoading(true); void load(); }}>Повторить</Button>
            <Link className="btn btn--sm" to="/schemes">К списку</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <nav className="breadcrumbs">
        <Link to="/schemes">Схемы домов</Link>
        <span>/</span>
        <span aria-current="page">{meta?.title || jobId}</span>
      </nav>
      <header className="page__header">
        <div>
          <p className="page__eyebrow">Распознавание</p>
          <h1 className="page__title">
            {meta?.title || 'Схема'}
            {meta ? <Badge tone={meta.status === 'completed' ? 'success' : meta.status === 'failed' ? 'danger' : 'info'}>{meta.status === 'completed' ? 'Готово' : meta.status === 'failed' ? 'Ошибка' : 'В обработке'}</Badge> : null}
          </h1>
          <p className="page__subtitle">
            {meta?.street ? `${meta.street}, дом ${meta.address}` : 'Проверка и корректировка CAD-схемы'}
          </p>
        </div>
        <div className="page__actions">
          <Button icon="refresh" onClick={() => setRefreshTick(tick => tick + 1)} disabled={loading}>Обновить</Button>
          <Button icon="cad" onClick={() => void importCad()} disabled={busy || !meta?.graphReady}>В CAD-редактор</Button>
          <Link className="btn" to={`/schemes?street=${params.get('street') || ''}&building=${params.get('building') || ''}`}><Icon name="list" /> К дому</Link>
        </div>
      </header>

      {!graph?.complete && meta?.status !== 'completed' ? (
        <div className="alert alert--info">
          <Spinner />
          <span>{meta?.progress || 'Обработка эскиза…'} Страница обновится автоматически.</span>
        </div>
      ) : null}

      {graph ? (
        <>
          <div className="tabs" role="tablist">
            {([
              ['graph', 'Граф'],
              ['nodes', `Узлы · ${nodes.length}`],
              ['edges', `Рёбра · ${edges.length}`],
              ['review', `Проверка · ${tasks.length + findings.length}`],
              ['cad', 'CAD'],
            ] as Array<[Tab, string]>).map(([key, label]) => (
              <button key={key} type="button" role="tab" className="tabs__tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>

          {tab === 'graph' ? (
            <div className="split">
              <Card
                title="Схема"
                actions={
                  <div className="layer-legend">
                    <label className="legend-swatch"><input type="checkbox" checked={showNodes} onChange={event => setShowNodes(event.target.checked)} /> Узлы</label>
                    <label className="legend-swatch"><input type="checkbox" checked={showCrossings} onChange={event => setShowCrossings(event.target.checked)} /> Пересечения</label>
                  </div>
                }
              >
                <GraphView graph={graph} visibleEdges={visibleEdges} showNodes={showNodes} showCrossings={showCrossings} selectedEdge={selectedEdge} onSelectEdge={setSelectedEdge} />
                <p className="field__hint" style={{ marginTop: 10 }}>
                  Нажмите на ребро, чтобы выделить его. Скрытие рёбер влияет только на просмотр.
                </p>
              </Card>
              <div className="stack">
                <Card title="Сводка">
                  <dl className="kv">
                    <dt>Узлов</dt><dd>{nodes.length}</dd>
                    <dt>Рёбер</dt><dd>{edges.length}</dd>
                    <dt>Подписей</dt><dd>{graph.annotations.length}</dd>
                    <dt>Пересечений</dt><dd>{graph.crossings.length}</dd>
                    <dt>Статус</dt><dd>{graph.analysisStatus || graph.statusline || '—'}</dd>
                  </dl>
                </Card>
                <Card title="Соединения" actions={<Badge tone="brand" plain>{graph.joinCandidates.length}</Badge>}>
                  {graph.joinCandidates.length === 0 ? (
                    <p className="field__hint">Кандидатов на соединение нет.</p>
                  ) : (
                    <div className="review-list">
                      {graph.joinCandidates.map(candidate => (
                        <div key={candidate.id} className="review-card">
                          <div className="review-card__head">
                            <span className="review-card__message">{candidate.from} → {candidate.to}</span>
                            <Badge tone={candidate.priority === 'high' ? 'warn' : 'default'}>{candidate.priority || 'низкий'}</Badge>
                          </div>
                          <span className="field__hint">Расстояние {candidate.distance ?? '—'} px · совпадение {Math.round((candidate.alignment || 0) * 100)}%</span>
                          <div className="review-card__actions">
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={busy}
                              onClick={() => void libraryApi.connect(jobId, { from: candidate.from, to: candidate.to, candidateId: candidate.id }).then(result => { setGraph(result.graph); notify('Соединение добавлено', 'success'); }).catch(cause => notify(cause instanceof Error ? cause.message : 'Ошибка', 'error'))}
                            >
                              Соединить
                            </Button>
                            {candidate.has_alternatives ? (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => void libraryApi.connect(jobId, { from: candidate.from, to: candidate.to, candidateId: candidate.id, confirmAlternative: true }).then(result => { setGraph(result.graph); notify('Альтернатива подтверждена', 'success'); }).catch(cause => notify(cause instanceof Error ? cause.message : 'Ошибка', 'error'))}
                              >
                                Альтернатива
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            </div>
          ) : null}

          {tab === 'nodes' ? (
            <Card title="Узлы схемы" flush>
              <div className="table-wrap" style={{ maxHeight: 560 }}>
                <table className="table">
                  <thead><tr><th>ID</th><th>X</th><th>Y</th><th>Степень</th><th /></tr></thead>
                  <tbody>
                    {nodes.map(node => (
                      <tr key={node.id}>
                        <td className="mono">{node.id}</td>
                        <td className="num">{Math.round(node.x)}</td>
                        <td className="num">{Math.round(node.y)}</td>
                        <td>{node.degree ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div className="row" style={{ justifyContent: 'flex-end' }}>
                            {tasks.filter(task => task.targetIds?.includes(node.id)).map(task => (
                              <Button key={task.id} size="sm" variant="ghost" onClick={() => openTask(task)}>{REVIEW_LABELS[task.kind || ''] || 'Проверить'}</Button>
                            ))}
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void libraryApi.review(jobId, { action: 'dismiss_task', targetId: node.id }).then(result => { setGraph(result.graph); notify('Замечание скрыто', 'success'); }).catch(cause => notify(cause instanceof Error ? cause.message : 'Ошибка', 'error'))}
                            >
                              Скрыть
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {tab === 'edges' ? (
            <Card title="Рёбра схемы" flush>
              <div className="table-wrap" style={{ maxHeight: 560 }}>
                <table className="table">
                  <thead><tr><th>Откуда</th><th>Куда</th><th>Детектор</th><th>Роль</th><th>Уверенность</th><th>Видимость</th><th /></tr></thead>
                  <tbody>
                    {edges.map(edge => (
                      <tr key={edge.id} style={selectedEdge === edge.id ? { background: 'var(--brand-soft)' } : undefined}>
                        <td className="mono">{edge.from}</td>
                        <td className="mono">{edge.to}</td>
                        <td>{edge.detector || '—'}</td>
                        <td>{edge.component_role || '—'}</td>
                        <td>{edge.confidence ? `${Math.round(edge.confidence * 100)}%` : '—'}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn--sm"
                            disabled={busy}
                            onClick={() => void libraryApi.connect(jobId, { from: edge.from, to: edge.to }).then(result => { setGraph(result.graph); notify(edge.visible === false ? 'Ребро восстановлено' : 'Ребро скрыто', 'success'); }).catch(cause => notify(cause instanceof Error ? cause.message : 'Ошибка', 'error'))}
                          >
                            {edge.visible === false ? 'Показать' : 'Скрыть'}
                          </button>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <Button size="sm" variant="ghost" onClick={() => { setSelectedEdge(edge.id); setTab('graph'); }}>Показать</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {tab === 'review' ? (
            <div className="stack">
              <Card title="Задания проверки" actions={<Badge tone="warn" plain>{tasks.length}</Badge>}>
                {tasks.length === 0 ? (
                  <Empty icon="check" title="Заданий нет">Все замечания обработаны.</Empty>
                ) : (
                  <div className="review-list">
                    {tasks.map(task => (
                      <div key={task.id} className="review-card">
                        <div className="review-card__head">
                          <span className="review-card__message">{task.message || task.kind}</span>
                          <Badge tone={task.status === 'dismissed' ? 'default' : 'warn'}>{task.status || 'открыто'}</Badge>
                        </div>
                        <span className="field__hint">{task.kind} · {task.targetIds?.join(', ')}</span>
                        <div className="review-card__actions">
                          <Button size="sm" variant="primary" disabled={busy} onClick={() => openTask(task)}>Обработать</Button>
                          <Button size="sm" disabled={busy} onClick={() => void runReview({ action: 'dismiss_task', targetId: task.targetIds?.[0] || '' })}>Скрыть</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
              <Card title="Замечания валидации" actions={<Badge tone={findings.length ? 'danger' : 'success'} plain>{findings.length}</Badge>}>
                {findings.length === 0 ? (
                  <Empty icon="check" title="Замечаний нет">Геометрия схемы согласована.</Empty>
                ) : (
                  <div className="review-list">
                    {findings.map(finding => (
                      <div key={finding.id} className="review-card">
                        <div className="review-card__head">
                          <span className="review-card__message">{finding.message || finding.code}</span>
                          <Badge tone={finding.severity === 'error' ? 'danger' : 'warn'}>{finding.severity || finding.status || '—'}</Badge>
                        </div>
                        <span className="field__hint">{finding.targetIds?.join(', ')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          ) : null}

          {tab === 'cad' ? (
            <div className="split">
              <Card title="CAD-схема">
                {graph.cadDraftSvgUrl ? (
                  <div className="canvas-frame canvas-frame--center">
                    <img src={graph.cadDraftSvgUrl} alt="Предпросмотр CAD-схемы" style={{ width: '100%', background: '#fff' }} />
                  </div>
                ) : (
                  <Empty icon="cad" title="CAD ещё не готов">Дождитесь завершения обработки.</Empty>
                )}
                <div className="row row--wrap" style={{ marginTop: 12 }}>
                  {graph.cadDraftSvgUrl ? <a className="btn btn--sm" href={graph.cadDraftSvgUrl} target="_blank" rel="noopener"><Icon name="external" /> Открыть SVG</a> : null}
                  {graph.cadDraftDxfUrl ? <a className="btn btn--sm" href={graph.cadDraftDxfUrl}><Icon name="download" /> Скачать DXF</a> : null}
                  <Button size="sm" variant="primary" icon="cad" disabled={busy} onClick={() => void importCad()}>Открыть в CAD-редакторе</Button>
                </div>
              </Card>
              <Card title="Исходный эскиз">
                {graph.sourceUrl ? (
                  <div className="canvas-frame canvas-frame--center">
                    <img className="source-image" src={graph.sourceUrl} alt="Исходный эскиз" />
                  </div>
                ) : (
                  <Empty icon="image" title="Нет изображения">Исходный файл не найден.</Empty>
                )}
                <p className="field__hint" style={{ marginTop: 10 }}>Оригинал: {graph.image?.width}×{graph.image?.height} px</p>
              </Card>
            </div>
          ) : null}
        </>
      ) : (
        <Card>
          <Empty icon="clock" title="Схема обрабатывается">{meta?.progress || 'Локальное распознавание ещё не завершилось.'}</Empty>
        </Card>
      )}

      {selectedTask ? (
        <Modal
          title={selectedTaskLabel}
          onClose={() => setSelectedTask(null)}
          footer={
            <>
              <Button onClick={() => setSelectedTask(null)}>Отмена</Button>
              <Button variant="primary" disabled={busy || !taskValue.trim()} onClick={() => void submitTask()}>Сохранить</Button>
            </>
          }
        >
          <p className="field__hint">{selectedTask.message || 'Укажите фактическое значение.'}</p>
          <Field label={selectedTaskLabel}>
            {selectedTask.kind === 'classify_symbol' ? (
              <select className="select" value={taskValue} onChange={event => setTaskValue(event.target.value)}>
                {(graph?.symbolCatalog || []).map(symbol => <option key={symbol.type} value={symbol.type}>{symbol.label}</option>)}
                <option value="unknown">Неизвестно</option>
              </select>
            ) : (
              <input className="input" value={taskValue} onChange={event => setTaskValue(event.target.value)} autoFocus />
            )}
          </Field>
          <p className="field__hint">Цель: {selectedTask.targetIds?.join(', ')}</p>
        </Modal>
      ) : null}
    </>
  );
}